# Telegram ↔ Claude Code Agent Bridge — Design

Date: 2026-11-09
Status: Approved by user 2026-11-09
Replaces an earlier WhatsApp draft and an earlier single-bot/topics draft (see §12).

## 1. Intent

The user runs several Claude Code sessions ("agents") on this Windows machine and wants to
reach them from their phone — to talk to them the same way they do in the terminal: real
back-and-forth conversation, asking them to take actions, deep discussion. Agents must also
message the user on their own (when they finish, have a question, or need a decision).

The picture the user described: **each agent is like a contact** — it has its own private
chat, and all agents also sit together in one group where the user can tag any of them. A
list of agents in the group lets the user tap one and jump to its private chat. The user can
also **start new agents from the phone**, including more than were planned for.

Telegram was chosen over WhatsApp (the user's original ask) because WhatsApp has no official
bot access for personal accounts: agent messages would count as "sent by you" and never
notify, and the workarounds carry ban risk. Telegram's official Bot API has neither problem.

Success = from the phone alone, the user can: see which agents are online, open any agent's
private chat or tag it in the group, have a normal conversation, approve/deny permission
prompts with a tap, start and stop agents, add capacity for another agent — and get a normal
Telegram notification whenever an agent replies, finishes, or needs a decision.

## 2. Goals

1. **One Telegram bot per agent, permanently.** Bots come from a **pool** the user creates in
   @BotFather. The first time an agent name is seen, it is bound to a never-used bot, which is
   renamed (display name) to the agent's name. That binding is permanent: the bot never
   speaks for any other agent, so each private chat holds exactly one agent's history.
   Restarting an agent always uses its own bot. Pool size therefore = number of distinct
   agents (projects) used over time, not number running at once.
2. **A hub bot** — one extra, fixed bot ("Claude Hub") that handles commands (`/list`, `/new`,
   `/stop`, `/addbot`) and stands in for agents that have no bot yet.
3. **Private chats:** each agent is reachable in its own bot's private chat.
4. **Group "Claude Agents":** the user, the hub bot, and all pool bots. The user tags an agent
   with a real Telegram mention (`@<its bot>`); the agent replies in the group under its own
   name. Agents only speak in the group when spoken to there.
5. **List and jump:** `/list` shows online agents as buttons; tapping one opens that agent's
   private chat.
6. **Start agents from the phone:** `/new` → pick a project folder → a new agent starts on the
   PC and comes online. `/stop <name>` stops one.
7. **Never blocked by pool size:** an agent with no free bot still starts and is reachable via
   the hub. The user can grow the pool from the phone (`/addbot <token>`).
8. Every agent, whether started from the PC (`crew`) or the phone (`/new`), is a normal
   interactive Claude Code session with full abilities and history.
9. **Reliable self-reporting:** when an agent finishes a turn or stops to wait for input, its
   private chat gets a message automatically (Claude Code hooks), even for tasks given at the
   terminal.
10. **Approvals:** sessions run in auto mode; any remaining permission request appears in the
    agent's private chat with **Allow / Deny** buttons.

Terminology: **agent = one Claude Code session on this PC = one Telegram bot.** Several agents
can work in the same project folder under different names.

## 3. Non-goals (v1)

- Preventing two agents in the same folder from editing the same files (same as running two
  terminal sessions today).
- Attaching to sessions while they are running, or started with plain `claude`. Only sessions
  started via `crew` or `/new` are reachable (channels must be enabled at launch). Existing
  sessions join by being restarted with `crew <name> --continue` (§6.4), keeping their history.
- Live activity feed of every tool call (deferred; hooks from Goal 9 make it easy later).
- Voice notes, images, files sent *from* Telegram into sessions.
- Fully automatic bot creation — Telegram doesn't allow creating bots via API; adding a bot
  always involves a short @BotFather chat by the user (doable on the phone).
- Running on another machine / always-on server. Runs on this PC while it's on.
- Multiple users.

## 4. Anti-goals (would be a failure even if it "works")

- **Anyone other than the user can drive an agent or start one.** Agents run commands on this
  machine. Every bot accepts updates only from the user's Telegram user id, and only in that
  user's private chat or the configured group. Everything else is ignored.
- **`/new` starts something outside the allowed project root.** Folder choice is restricted
  to the configured root(s); no free-text paths that escape it.
- **Messages go to the wrong agent.** Unroutable → say so and show `/list`; never guess.
- **Two agents' histories mix in one chat.** A bot is never silently handed from one agent to
  another (see binding rule, Goal 1, and `/retire`, §7.4).
- **Notification spam.** One finished task = one notification (see §7.6).
- **Secrets leak.** Bot tokens and config never committed or logged.

## 5. Key facts the design rests on

- **Claude Code channels** (research preview): an MCP server spawned by Claude Code over stdio,
  declaring `claude/channel`, pushes inbound messages via `notifications/claude/channel`;
  Claude replies through a tool the channel exposes.
  Reference: https://code.claude.com/docs/en/channels-reference
- Custom channels aren't on the allowlist → sessions start with
  `--dangerously-load-development-channels` (confirm syntax for installed v2.1.319).
- **Permission relay:** declaring `claude/channel/permission` → Claude Code sends
  `notifications/claude/channel/permission_request` and accepts a verdict; terminal and remote
  race, first wins. Take exact field names from the official reference.
- **Anthropic's official Telegram channel plugin** exists (one session per bot). Read its
  source for message handling, formatting and permission buttons; reuse what fits.
- **Telegram Bot API facts used:**
  - Only one process may poll `getUpdates` per token → one bridge owns all tokens.
  - `setMyName` changes a bot's display name (rate-limited — verify, §9). Usernames are fixed.
  - Bots cannot message a user first → the user must `/start` each bot once. The hub sends a
    `t.me/<bot>?start=…` button to make this one tap.
  - Bots cannot add other bots to groups → the hub sends a `t.me/<bot>?startgroup=…` button;
    the user taps it and picks the group (one tap + confirm).
  - With privacy mode on, a bot in a group still receives messages that @mention it, replies to
    its messages, and commands — enough for pool bots. The hub needs to see commands only.
  - Inline keyboards + callback queries for buttons; URL buttons for "open chat".
  - Message limit 4096 chars. Bot messages notify normally.
- Environment: Windows 11, Node v22.12.0, Claude Code 2.1.319, Windows Terminal assumed
  available (fallback: a plain PowerShell window).

## 6. Architecture

```
 Phone (Telegram)                         This PC
 ────────────────────          ──────────────────────────────────────────────────
  Hub bot (private chat) ◄────►┌──────────────── bridge (1 process) ─────────────┐
  "backend" bot (private)◄────►│ Polls hub + all pool bot tokens                 │
  "docs" bot (private)   ◄────►│ Pool manager: assign / rename / release bots    │
  Group "Claude Agents"  ◄────►│ Router: chat / mention → agent; agent → chat    │
   (hub + pool bots)           │ Launcher: /new → opens terminal running crew     │
                               │ Local server 127.0.0.1 (token-protected)        │
                               └──────▲──────────────────▲──────────────▲────────┘
                                      │                  │              │ hook POSTs
                          ┌───────────┴──────┐ ┌─────────┴────────┐     │
                          │ channel (MCP)    │ │ channel (MCP)    │     │
                          │ agent "backend"  │ │ agent "docs"     │     │
                          └────────▲─────────┘ └────────▲─────────┘     │
                                   │ stdio              │ stdio         │
                            claude (backend) ───────────┴───────────────┘
```

One Node/TypeScript project, five pieces.

### 6.1 Bridge (one per machine, long-running)
- Polls the hub token and every pool token; sends messages; handles button taps.
- **Pool manager:** pool = list of bot tokens, each either *unused* or *bound to agent X*
  (permanent). A new agent name binds to an unused bot and `setMyName(<agent name>)` is called
  once. A known agent name always uses its bound bot, whether online or not. A bound bot whose
  agent is offline stays bound (it answers "<name> is offline"). Only `/retire` unbinds.
- Agent registry: name → channel connection, folder, start time, assigned bot (or none),
  session process id.
- Local server bound to `127.0.0.1`, shared-secret protected (secret in git-ignored state dir).
- Persists: tokens, user id, group id, bot↔agent history, projects root(s).

### 6.2 Channel (one per session, spawned by Claude Code)
- MCP server over stdio; declares `claude/channel` and `claude/channel/permission`.
- Reads agent name from env, connects to the bridge (retries quietly if down; session works
  locally meanwhile). Reports its parent `claude` process id so `/stop` can end it.
- Inbound → `notifications/claude/channel` with text and origin (private chat / group /
  hub-overflow) so Claude knows context.
- `reply` tool (text, optional file). Channel `instructions`: answer Telegram messages with
  `reply`; keep it phone-readable; the user may not be at the terminal.
- Relays permission requests/verdicts.

### 6.3 Hooks
- Injected per session by the launcher (e.g. `--settings` file) — the user's global settings
  are not modified. **Stop** and **Notification** events POST agent name + event + short
  summary (Stop: last assistant message, trimmed) to the bridge.
- Bridge posts to the agent's private chat: `✅ done — <summary>` / `⏳ waiting — <reason>`.

### 6.4 `crew` launcher (PC side)
- `crew [name] [extra claude args]` in a project folder; name defaults to folder name.
- Ensures bridge is running (starts it in background if not), then starts `claude` with the
  dev-channel flag, auto permission mode, hook settings, agent name env var.
- Extra args pass straight through to `claude`. This is how existing sessions join: the user
  exits a running session and restarts it as `crew <name> --continue` (or `--resume` to pick a
  conversation) in the same folder — full history kept, now reachable from Telegram. Must be
  verified to work with the channel/hook flags `crew` adds.
- Several agents may run in the same folder; bots belong to agent *names*, not folders.
  If the name is already used by an online agent, `crew` asks for another name (suggesting
  `backend-2`) rather than silently suffixing — the name becomes a permanent bot, so the
  user should choose it.
- `crew setup` (one-time, §7.1), `crew status`, `crew stop-bridge`.
- Installed to run from any terminal (PowerShell function or npm global bin — builder's call).

### 6.5 Remote launch (`/new`)
- Bridge opens a new terminal window **minimized** (Windows Terminal, fallback PowerShell)
  running `crew <name>` in the chosen folder — a real window so the user can take over at the
  desk (Claude Code sessions are interactive), minimized so windows don't pop up while away.
  Closing the window ends the agent. Laptop must be on, awake, signed in (locked is fine).
- Folder choices: immediate subfolders of the configured projects root(s), shown as buttons
  (paged if many), grouped by root. Configured roots: `C:\personalProjects` and
  `C:\workProjects` (user's choice); more can be added in config.

## 7. Behaviour

### 7.1 One-time setup (`crew setup`, on the PC)
1. Create the hub bot + an initial pool (suggested 5) in @BotFather; paste tokens. Disable
   nothing special; pool bots keep privacy mode on.
2. Create the "Claude Agents" group; add hub and pool bots (or let the hub's
   `startgroup` buttons do it).
3. Send `/pair` to the hub in the group. Bridge records group id + sender's user id as the
   only allowed user. Pairing accepted only while `crew setup` is running.
4. Hub sends one-tap `/start` buttons for every pool bot so their private chats are open.
5. Ask for projects root(s); defaults `C:\personalProjects` and `C:\workProjects`.

### 7.2 Agent lifecycle
- Online → use the agent's bound bot; if it's a new name, bind an unused bot and rename it.
  Post `🟢 online — <folder>` in the agent's private chat and a one-liner in the group.
- New name and no unused bot → agent runs in **overflow**: reachable via the hub (see 7.3),
  and the hub sends: "No free bot for *api*. Create one in @BotFather and send me the token
  with `/addbot <token>`." When a bot is added, the oldest overflow agent binds to it
  automatically and the hub posts the "open chat" button.
- Offline (session closed / channel gone) → `🔴 offline` in its chat. The bot stays bound.
  Messages to an offline agent → "<name> is offline" (with a button to start it again).

### 7.3 Talking to agents
- **Private chat** with an agent's bot → that agent. Replies there.
- **Group:** `@<agent's bot> …` → that agent; it replies in the group (as a reply to the
  user's message). `@all …` sent to the hub → every online agent.
- **Overflow agents:** in the hub's private chat or the group, `@<name> …` (plain text,
  parsed by the hub) → that agent; replies come from the hub prefixed `[<name>]`.
- Unprompted messages and hook messages → the agent's private chat (or the hub's chat,
  prefixed, for overflow agents). Never into the group.

### 7.4 Hub commands (group or hub private chat)
- `/list` — online agents (name, folder, uptime) as URL buttons opening each private chat;
  overflow agents marked.
- `/new` — folder buttons → name (default folder name; if an agent with that name is online,
  the hub asks for a different name and suggests `<folder>-2`) → launches (§6.5).
- `/stop <name>` (or a stop button from `/list`) — confirm, then end that session's process.
- `/addbot <token>` — validates token, adds to pool, replies with one-tap buttons to `/start`
  it and add it to the group. The user deletes the token message afterwards (hub reminds).
- `/bots` — pool status: unused / bound to which agent / online or not.
- `/retire <name>` — permanently unbinds an agent's bot. Because Telegram keeps the chat
  history, the hub first asks the user to clear that chat ("Clear history" in Telegram) and
  confirm; only then is the bot renamed "💤 unused" and returned to the pool. A retired
  agent name that starts again later is treated as new.

### 7.5 Approvals
- Permission request → agent's private chat: `⚠️ wants to: <tool + short description>` with
  **Allow / Deny**. After an answer (phone or terminal) the message is edited to show the
  outcome and buttons are removed.

### 7.6 Formatting and de-duplication
- Markdown → Telegram formatting; code blocks preserved.
- Over ~4,000 chars or big code/diffs → `.md`/`.txt` document + one-line summary.
- If the agent already sent a `reply` during the turn, the Stop hook's `✅ done` is sent
  silently (`disable_notification`) or skipped — one task, one notification.

## 8. Security
- Bridge server bound to `127.0.0.1`, secret-protected.
- All bots: accept only the allowed user id, only in their private chat with that user or the
  configured group.
- `/new` restricted to subfolders of configured roots.
- Tokens, secret, ids, pool state in one local state dir, git-ignored. `.gitignore` also
  includes `.agentTempWork/`. No message content in logs by default.

## 9. Open items to verify early (spike first)
1. Exact channel protocol for v2.1.319 — capability names, notification fields, permission
   fields, dev-channel flag syntax.
2. `setMyName` rate limits — renaming now only happens on bind and retire, so this should be
   a non-issue; confirm.
3. Injecting the channel and hooks per session without touching global settings on Windows
   (`--settings`, `--mcp-config`, or plugin).
4. Opening a visible Windows Terminal window running `crew` from a background bridge process
   (works when the bridge was started from a terminal; check when started by `crew` in the
   background).
5. Reliable `/stop`: ending the `claude` process (and its children) cleanly on Windows.
6. Terminal-originated turns shouldn't send their normal output to Telegram except via the
   Stop hook.

## 10. Left to the builder
Package layout, bridge↔channel transport, Telegram library (e.g. grammY) or raw Bot API,
reconnect timings, wording/emoji, paging of folder lists, test approach. Personal tool —
keep it small.

## 11. Later (not v1)
Activity feed (`/feed on|off`), voice notes / images from phone, always-on machine,
bot profile pictures per agent.

## 12. Decisions log
- Telegram instead of WhatsApp — user's decision after WhatsApp's notification and ban-risk
  problems were explained.
- One bot per agent from a pool, plus a group, plus `/list` buttons into private chats — the
  user's design. (Replaced Claude's earlier single-bot/topics idea.)
- Starting/stopping agents from the phone, and growing the pool from the phone — user's ask.
- Permanent bot↔agent binding, no reuse between agents — user's decision (reuse would mix
  two agents' histories in one chat). `/retire` with a clear-history step — Claude's call.
- Resuming from the phone: added after v1 at the user's request. `/resume` or the offline message's Resume button lists the last 8 conversations in the agent's folder and launches with `--resume <id>`.
- Hub bot as a separate fixed bot; overflow mode for agents without a bot — Claude's call.
- Remotely started agents open in a minimized terminal window — Claude's call (user: "fine
  either way").
- Allowed project roots `C:\personalProjects` and `C:\workProjects` — user's choice.
- Agents only speak in the group when addressed there; unprompted/hook messages go to private
  chats — Claude's call (avoids duplicate notifications).
- Bridge auto-started by `crew`; one-time `crew setup` for tokens and pairing — Claude's call.
- Stop/Notification hooks for reliable "done / waiting" messages in v1 — Claude's call.
- Activity feed deferred — user asked to keep v1 simple.
