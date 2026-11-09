# Telegram Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reach every Claude Code session on this PC from Telegram — one bot per agent, a shared group, and start/stop from the phone.

**Architecture:** One `bridge` process owns all bot tokens (long polling) and a localhost HTTP server. Each Claude session loads `channel.js` (MCP channel over stdio) which registers with the bridge and runs its own tiny localhost HTTP server for pushes. A Stop hook posts "done" summaries. `crew` launches sessions inside a pseudo-terminal so it can auto-confirm the dev-channel warning.

**Tech Stack:** Plain JavaScript (ESM, Node 22, no build step), `@modelcontextprotocol/sdk`, `zod`, `node-pty`. Telegram Bot API via `fetch` (no Telegram library). Tests: `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-09-telegram-agent-bridge-design.md`

## Global Constraints

- User asked: **as little code as possible, easy to understand.** Small files, no classes unless needed, no TypeScript, no framework.
- Windows 11, Node v22.12.0, Claude Code 2.1.319. `claude` is `C:\Users\Lenovo\.local\bin\claude.exe`.
- All runtime state lives in `<repo>/.state/` (git-ignored). Nothing is written outside the repo folder (user rule). Putting `bin/` on PATH is a manual user step.
- No git commits (folder is not a repo; user commits only when asked). Steps say "checkpoint" instead.
- Allowed project roots: `C:\personalProjects`, `C:\workProjects`.
- Only the paired Telegram user id, in their private chats or the paired group, is ever obeyed.

### Facts verified by spike (2026-11-09)
- Launch: `claude --mcp-config <file> --dangerously-load-development-channels server:<name> --settings <file> ...`. Works even though the banner says "no MCP server configured with that name".
- A full-screen warning appears first; option 1 is preselected → sending `\r` once confirms it.
- Inbound: `notifications/claude/channel` `{content, meta}` (meta keys `[A-Za-z0-9_]` only). Claude replies by calling our `reply` tool.
- Permission relay: capability `experimental['claude/channel/permission']`; Claude Code sends `notifications/claude/channel/permission_request {request_id, tool_name, description, input_preview}`; we answer `notifications/claude/channel/permission {request_id, behavior: 'allow'|'deny'}`.
- The `reply` tool needs pre-approval: `--settings` with `permissions.allow: ["mcp__tg__reply"]` works.
- Stop hook stdin JSON includes `last_assistant_message`. Hooks inherit the session env (so `CREW_AGENT` is visible).
- `process.ppid` inside the channel = the `claude.exe` pid.
- Env vars `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` must be removed before launching `claude`, or settings/hooks are ignored when launched from inside another Claude session.

### Simplifications vs spec (Claude's calls, to keep code small)
- Messages are sent as plain text (no markdown conversion). Over 4000 chars → sent as a `.md` document.
- Group-wide commands use slash commands so the hub needs no privacy changes: `/all <msg>`, `/to <name> <msg>` (overflow agents). Pool bots are addressed with real `@mentions`.
- Only the **Stop** hook is used (no Notification hook): permission prompts already relay, and a question from the agent arrives in the Stop summary. If the agent already called `reply` during that turn, the Stop message is skipped.
- When a permission is answered in the terminal, the Telegram prompt is not cleaned up; tapping it later just shows "already answered or expired".

## Review Focus

1. **Messages from anyone else** (another user in the group, a stranger DMing a bot, another group) → silently ignored. Test in Task 2.
2. **`/new` folder escape** — folder choice can only come from the listed subfolders of the two roots; a stale/forged callback index → rejected. Test in Task 2.
3. **Bridge restarts while sessions run** → channels re-register within 15 s and routing resumes. Test in Task 4 (heartbeat re-register).
4. **Agent name reused / bot bound forever** — restarting `backend` gets the same bot; a new name never takes a bound bot; retire requires confirm. Test in Task 1.
5. **Huge reply or weird characters** (>4096 chars, emoji, code) → never fails to send; long goes as a document. Test in Task 3.

---

## File Structure

```
package.json
bin/crew.cmd              # @node "%~dp0..\src\crew.js" %*
src/state.js             # paths, load/save .state/config.json + .state/pool.json, secret
src/pool.js              # pure: bind/lookup/retire bots for agent names
src/route.js             # pure: turn a Telegram update into an action (incl. allowlist), list folders
src/telegram.js          # tg() call, sendText() (splits to document), poll loop
src/bridge.js            # the long-running process: HTTP API + bots + launcher
src/channel.js           # MCP channel loaded into each Claude session
src/hook.js              # Stop hook → POST /hook
src/crew.js               # CLI: launch (pty proxy), setup, status, stop-bridge
test/pool.test.js
test/route.test.js
test/telegram.test.js
README.md                # setup + daily use, short
```

Bridge HTTP API (all on `127.0.0.1:8790`, header `x-secret: <secret>` required):

| Route | Body (JSON) | Purpose |
|---|---|---|
| `POST /register` | `{name, folder, port, pid}` | channel online / heartbeat (every 15 s) → `{ok, name}` |
| `POST /unregister` | `{name}` | channel exiting |
| `POST /reply` | `{name, chat_id, text}` | agent → Telegram |
| `POST /permission` | `{name, request_id, tool_name, description, input_preview}` | ask user Allow/Deny |
| `POST /hook` | `{name, last_assistant_message}` | Stop hook |
| `GET /agents` | – | `{agents:[{name, folder, online}]}` (used by `crew` name check, `crew status`) |

Channel HTTP API (`127.0.0.1:<random port>`, same secret): `POST /message {text, chat_id, from}` and `POST /verdict {request_id, behavior}`.

---

### Task 1: State and bot pool

**Files:**
- Create: `package.json`, `src/state.js`, `src/pool.js`
- Test: `test/pool.test.js`

**Interfaces:**
- Produces:
  - `state.js`: `ROOT` (repo dir), `STATE_DIR` (`ROOT/.state`), `BRIDGE_PORT = 8790`, `loadConfig() -> {hubToken, userId, groupId, roots: string[]} | null`, `saveConfig(cfg)`, `loadPool() -> Pool`, `savePool(pool)`, `getSecret() -> string` (creates 32-hex-char random secret in `.state/secret` on first call).
  - `pool.js` (pure, no I/O). `Pool = {bots: [{token, username, agent: string|null}]}`.
    - `botFor(pool, agent) -> bot|null` — bot bound to that agent name.
    - `bindNew(pool, agent) -> bot|null` — first bot with `agent === null`; sets `bot.agent = agent`; returns null if none unused or already bound (then returns the existing one).
    - `addBot(pool, token, username) -> bot` — ignores duplicates by token.
    - `retire(pool, agent) -> bot|null` — sets `agent = null`, returns the bot.

- [ ] **Step 1: `package.json`** — `"type": "module"`, scripts `"test": "node --test"`, deps `@modelcontextprotocol/sdk`, `zod`, `node-pty`. Run `npm install`. Expected: installs, no errors.

- [ ] **Step 2: Write failing tests `test/pool.test.js`**

```js
test('new agent binds first unused bot, same agent keeps it', () => {
  const p = { bots: [{ token: 'a', username: 'b1', agent: null }, { token: 'b', username: 'b2', agent: null }] }
  assert.equal(bindNew(p, 'backend').token, 'a')
  assert.equal(bindNew(p, 'backend').token, 'a')      // idempotent
  assert.equal(bindNew(p, 'docs').token, 'b')
  assert.equal(bindNew(p, 'api'), null)               // pool exhausted
  assert.equal(botFor(p, 'docs').token, 'b')
})
test('retire frees the bot; a new name may then take it', () => {
  const p = { bots: [{ token: 'a', username: 'b1', agent: 'backend' }] }
  assert.equal(retire(p, 'backend').token, 'a')
  assert.equal(botFor(p, 'backend'), null)
  assert.equal(bindNew(p, 'docs').token, 'a')
})
test('addBot ignores duplicate tokens', () => {
  const p = { bots: [] }; addBot(p, 't', 'u'); addBot(p, 't', 'u')
  assert.equal(p.bots.length, 1)
})
```

- [ ] **Step 3: Run** `node --test test/pool.test.js` → FAIL (module missing).
- [ ] **Step 4: Implement** `src/state.js` and `src/pool.js` per Interfaces. JSON files, pretty-printed.
- [ ] **Step 5: Run** `node --test test/pool.test.js` → PASS. Checkpoint.

---

### Task 2: Routing (pure)

**Files:**
- Create: `src/route.js`
- Test: `test/route.test.js`

**Interfaces:**
- Consumes: `Pool`, `botFor` from Task 1.
- Produces:
  - `isFromOwner(update, cfg) -> boolean` — true only if `from.id === cfg.userId` and (`chat.type === 'private'` with `chat.id === cfg.userId`, or `chat.id === cfg.groupId`). Works for both `message` and `callback_query` updates.
  - `parseHub(text) -> {cmd, args}` — `/list`, `/bots`, `/new [name]`, `/stop <name>`, `/retire <name>`, `/addbot <token>`, `/all <msg>`, `/to <name> <msg>`, `/pair`; strips `@HubBot` suffix from commands (`/list@MyHub`); unknown → `{cmd: 'help'}`.
  - `stripMention(text, username) -> string` — removes `@username` (case-insensitive) and trims.
  - `listFolders(roots) -> [{root, name, path}]` — immediate subdirectories of each root that exist, sorted, skipping names starting with `.`.
  - `folderFromIndex(list, index) -> path|null` — null unless `0 <= index < list.length` and integer.

- [ ] **Step 1: Write failing tests**

```js
const cfg = { userId: 1, groupId: -100 }
const msg = (fromId, chatId, type = 'private') => ({ message: { from: { id: fromId }, chat: { id: chatId, type }, text: 'x' } })
test('owner in private chat or paired group is accepted', () => {
  assert.ok(isFromOwner(msg(1, 1), cfg))
  assert.ok(isFromOwner(msg(1, -100, 'supergroup'), cfg))
})
test('anyone else is ignored', () => {
  assert.ok(!isFromOwner(msg(2, 2), cfg))                     // stranger DM
  assert.ok(!isFromOwner(msg(2, -100, 'supergroup'), cfg))    // other member in group
  assert.ok(!isFromOwner(msg(1, -999, 'supergroup'), cfg))    // owner in another group
})
test('callback queries are checked too', () => {
  const cb = { callback_query: { from: { id: 2 }, message: { chat: { id: -100, type: 'supergroup' } } } }
  assert.ok(!isFromOwner(cb, cfg))
})
test('hub commands parse', () => {
  assert.deepEqual(parseHub('/to backend run tests'), { cmd: 'to', args: ['backend', 'run tests'] })
  assert.deepEqual(parseHub('/list@ClaudeHubBot'), { cmd: 'list', args: [] })
  assert.deepEqual(parseHub('/all hi there'), { cmd: 'all', args: ['hi there'] })
  assert.equal(parseHub('hello').cmd, 'help')
})
test('stripMention', () => assert.equal(stripMention('@Agent1_Bot run it', 'agent1_bot'), 'run it'))
test('folderFromIndex rejects bad indexes', () => {
  const list = [{ path: 'C:\\personalProjects\\a' }]
  assert.equal(folderFromIndex(list, 0), 'C:\\personalProjects\\a')
  for (const bad of [-1, 1, 0.5, NaN, '0; rm']) assert.equal(folderFromIndex(list, bad), null)
})
```
`args` for `/to` is `[name, rest]`; for `/all` `[rest]`; for `/new`, `/stop`, `/retire`, `/addbot` `[word]` or `[]`.

- [ ] **Step 2: Run** `node --test test/route.test.js` → FAIL.
- [ ] **Step 3: Implement** `src/route.js`.
- [ ] **Step 4: Run** → PASS. Checkpoint.

---

### Task 3: Telegram client

**Files:**
- Create: `src/telegram.js`
- Test: `test/telegram.test.js`

**Interfaces:**
- Produces:
  - `tg(token, method, params = {}) -> Promise<result>` — POST JSON to `https://api.telegram.org/bot<token>/<method>`; throws `Error(description)` when `ok` is false.
  - `sendText(token, chatId, text, extra = {})` — if `text.length <= 4000`: `sendMessage` (plain text, `extra` merged, e.g. `reply_markup`, `reply_to_message_id`, `disable_notification`); else `sendDocument` with `reply.md` (multipart via `FormData` + `Blob`) and caption = first 200 chars.
  - `chunkOrDoc(text) -> 'message'|'document'` — pure helper used by `sendText` (the tested part).
  - `poll(token, onUpdate)` — infinite loop: `getUpdates {offset, timeout: 30, allowed_updates: ['message','callback_query']}`; calls `onUpdate(update)` for each (errors caught and logged); on network error waits 5 s and continues.
  - `button(text, data)` → `{text, callback_data: data}`; `urlButton(text, url)` → `{text, url}`; `keyboard(rows)` → `{inline_keyboard: rows}`.

- [ ] **Step 1: Failing test**

```js
test('long text goes as document', () => {
  assert.equal(chunkOrDoc('hi 👋'), 'message')
  assert.equal(chunkOrDoc('x'.repeat(4000)), 'message')
  assert.equal(chunkOrDoc('x'.repeat(4001)), 'document')
})
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. Checkpoint.

---

### Task 4: Channel (inside each Claude session)

**Files:**
- Create: `src/channel.js`

**Interfaces:**
- Consumes: `getSecret`, `BRIDGE_PORT` (Task 1). Env `CREW_AGENT` (agent name), `CREW_FOLDER`.
- Produces: MCP server named `tg` (so tool id is `mcp__tg__reply`). Bridge routes listed above.

Behaviour:
- Capabilities `experimental: {'claude/channel': {}, 'claude/channel/permission': {}}`, `tools: {}`.
- `instructions`: "You are agent "<name>". Messages from the user's phone (Telegram) arrive as <channel source="tg" chat_id="..." from="...">. The user may not be at the computer: answer every such message with the reply tool, passing its chat_id. Keep replies short and phone-readable."
- Tool `reply {chat_id: string, text: string}` → `POST /reply`; returns "sent" or the bridge error text.
- Starts `http.createServer` on `127.0.0.1` port 0; `/message` → `notifications/claude/channel {content: text, meta: {chat_id, from}}`; `/verdict` → `notifications/claude/channel/permission`. Both check `x-secret`.
- Permission request notification → `POST /permission`.
- Registers `{name, folder, port, pid: process.ppid}` now and every 15 s (this re-registers after a bridge restart — Review Focus 3). Bridge-down errors are ignored silently. On `SIGINT`/`SIGTERM`/stdin close → `POST /unregister`, exit.
- If bridge answers register with a different `name` (shouldn't happen — `crew` checks first), use it.

- [ ] **Step 1: Implement `src/channel.js`.**
- [ ] **Step 2: Smoke test** — with no bridge running: `$env:CREW_AGENT='t'; node src/channel.js` starts and waits on stdin without crashing for 20 s (Ctrl+C to end). Expected: no output on stdout except MCP traffic; no exception.
- Checkpoint.

---

### Task 5: Stop hook

**Files:**
- Create: `src/hook.js`

Reads stdin JSON, `POST /hook {name: process.env.CREW_AGENT, last_assistant_message}`; always exits 0 within 3 s (fetch with `AbortSignal.timeout(3000)`), never prints to stdout.

- [ ] **Step 1: Implement.** **Step 2:** `'{"last_assistant_message":"x"}' | node src/hook.js; $LASTEXITCODE` → `0` with no bridge running. Checkpoint.

---

### Task 6: Bridge

**Files:**
- Create: `src/bridge.js`

**Interfaces:**
- Consumes: everything from Tasks 1–3. Channel HTTP API from Task 4.
- Produces: process started by `node src/bridge.js`; writes `.state/bridge.pid`; logs to `.state/bridge.log` (no message text, only events).

In-memory: `agents = Map<name, {folder, port, pid, lastSeen, repliedThisTurn}>`; online = `Date.now() - lastSeen < 45000`. `pending` = map chatId → awaiting-name info for `/new`. `folderList` = last list shown by `/new`.

Polling: `poll(hubToken, onHub)` and `poll(bot.token, u => onAgentBot(bot, u))` for each pool bot (also started when `/addbot` adds one). Every update first passes `isFromOwner` — except `/pair` handling, which lives only in `crew setup`.

Agent-side events:
- `/register`: new name → if `botFor` none, `bindNew`; if bound now and name new → `setMyName({name})` on that bot, save pool. If it wasn't online before → post `🟢 <name> online — <folder>` to its private chat (or hub chat as `[name]` if overflow) and `🟢 <name>` to the group via hub. Overflow → hub sends "No free bot for <name>. Create one in @BotFather and send /addbot <token>".
- `/unregister` and missed heartbeats (checked every 15 s) → `🔴 <name> offline` in its chat.
- `/reply {chat_id}` → which bot sends? If `chat_id === groupId` → agent's bot (or hub with `[name] ` prefix if overflow) into group; otherwise agent's bot into user's private chat (hub + prefix if overflow). Sets `repliedThisTurn = true`.
- `/permission` → agent's private chat: `⚠️ <name> wants to use <tool_name>: <description>\n\n<input_preview (first 1500 chars)>` with buttons `Allow` / `Deny`, callback data `p:<request_id>:a` / `p:<request_id>:d`; remember `request_id → name`.
- `/hook` → if `repliedThisTurn` → just reset it; else send `✅ <first 3500 chars of last_assistant_message>` to the agent's private chat.

Telegram-side, agent bot (`onAgentBot(bot, update)`):
- Private message → agent `bot.agent`; if offline → reply "<name> is offline" + button `Start it` (`s:<name>`).
- Group message (only arrives when it @mentions the bot or replies to it) → `stripMention` → forward with `chat_id = groupId`.
- Forward = `POST http://127.0.0.1:<port>/message {text, chat_id, from: 'telegram'}`, with `repliedThisTurn = false`.
- Callback `p:<id>:a|d` → POST `/verdict` to the agent; edit the message to append "→ Allowed/Denied". Unknown id → `answerCallbackQuery` "already answered or expired".
- Callback `s:<name>` → launch (below) in the folder last seen for that name.

Telegram-side, hub (`onHub(update)`): `parseHub` then
- `list` → one line per known agent (online first) + `urlButton(name, 'https://t.me/<username>')` per bound bot; overflow agents marked "(via hub — /to name …)".
- `bots` → each pool bot: `@username → agent | unused`.
- `new [name]` → buttons of `listFolders(cfg.roots)` (`n:<index>`), max 40, grouped by root in the label. Tap → folder; name = given name or folder basename lowercased with spaces→`-`; if that name is online → ask "Name for the new agent in <folder>?" and take the next plain text in that chat. Then launch.
- `stop <name>` → confirm buttons `x:<name>` → `taskkill /PID <pid> /T /F`.
- `retire <name>` → message "First clear this agent's chat history in Telegram (open chat → ⋮ → Clear history), then tap Confirm." + button `r:<name>`. Confirm → `retire` + `setMyName({name: '💤 unused'})` + save.
- `addbot <token>` → `getMe` to validate → `addBot` + save + start polling it + reply with `urlButton('Open chat', 't.me/<u>?start=hi')` and `urlButton('Add to group', 't.me/<u>?startgroup=hi')` + "delete your token message". Then bind oldest overflow agent if any.
- `all <msg>` → forward to every online agent (their replies come back in the group if sent from the group, else private).
- `to <name> <msg>` → forward to that agent.
- `help` → short list of commands.

Launch(folder, name): `spawn('cmd.exe', ['/c', 'start', '"' + name + '"', '/min', 'cmd', '/c', path to bin/crew.cmd, name], {cwd: folder, detached: true, stdio: 'ignore', windowsVerbatimArguments: false}).unref()`. Folder must come from `folderFromIndex` or an agent's last known folder (Review Focus 2). Reply "Starting <name>…".

Bridge must keep running if any single Telegram call fails (log and continue).

- [ ] **Step 1: Implement `src/bridge.js`.**
- [ ] **Step 2:** `node --check src/bridge.js` → no output. Full end-to-end check happens in Task 8.
- Checkpoint.

---

### Task 7: `crew` CLI

**Files:**
- Create: `src/crew.js`, `bin/crew.cmd`

Commands:
- `crew setup` — interactive (readline): hub token → `getMe`; pool tokens (one per line, empty line ends) → `getMe` each; roots (default `C:\personalProjects,C:\workProjects`). Saves config/pool. Then prints "Create a group, add the hub bot, send /pair in it" and polls the hub until a `/pair` from a group arrives → saves `userId = from.id`, `groupId = chat.id`, replies "Paired ✅". Then sends the user (via hub in the group) `Open chat` + `Add to group` buttons for every pool bot. Exits. (Bridge must not be running during setup — stop it first.)
- `crew status` — bridge up? (`GET /agents`), print agents.
- `crew stop-bridge` — kill pid in `.state/bridge.pid`.
- `crew [name] [claude args…]` — default:
  1. If no config → tell user to run `crew setup`, exit 1.
  2. Ensure bridge: if `GET /agents` fails → spawn `node src/bridge.js` detached/hidden, wait up to 5 s for it.
  3. name = arg or folder basename (lowercase, spaces→`-`). If the first arg starts with `-`, it is a claude arg, not a name. If `GET /agents` shows the name online → ask "'<name>' is already running. Name for this agent:" (suggest `<name>-2`).
  4. Write `.state/sessions/<name>.mcp.json` (`{mcpServers: {tg: {command: 'node', args: [<abs channel.js>]}}}`) and `.state/sessions/<name>.settings.json` (`permissions.allow: ['mcp__tg__reply']`, `hooks.Stop: [{hooks: [{type:'command', command: 'node "<abs hook.js>"'}]}]`).
  5. Spawn via `node-pty`: `claude.exe --mcp-config <f> --dangerously-load-development-channels server:tg --settings <f> --permission-mode auto ...extraArgs`, cwd = current folder, env = process.env minus the session-marker vars listed in Global Constraints, plus `CREW_AGENT`, `CREW_FOLDER`.
  6. Proxy: stdin raw → pty, pty → stdout, resize on `process.stdout` `resize`. Watch output (ANSI-stripped, whitespace removed) for `Iamusingthisforlocaldevelopment`; send `\r` once. Exit with claude's exit code.
- `bin/crew.cmd`: `@node "%~dp0..\src\crew.js" %*`

- [ ] **Step 1: Implement.**
- [ ] **Step 2:** `node src/crew.js status` with no bridge → prints "bridge not running", exit 0.
- Checkpoint.

---

### Task 8: End-to-end check and README

**Files:**
- Create: `README.md` (setup in ≤10 steps, daily use, commands, how existing sessions join: `/exit` then `crew <name> --continue`, the PATH step, safety notes).

- [ ] **Step 1:** `npm test` → all pass.
- [ ] **Step 2: Local e2e without Telegram** — start bridge with a fake config? No: instead run a channel + bridge with real config only after the user has done `crew setup` (needs their bot tokens and phone). Until then, verify with the spike-style harness: start `bridge.js` with `.state/config.json` pointing at no tokens is NOT supported — so this step is **performed with the user**: user runs `crew setup`, then `crew test-agent` in a scratch folder, and from the phone: message the bot, `/list`, `/new`, a permission prompt, `/stop`.
- [ ] **Step 3:** Fresh-eyes review of the whole codebase (one reviewer subagent), focused on Review Focus items.

---

## Self-review notes
- Spec §7.3 `@all` in group → `/all` (privacy-mode simplification, noted above).
- Spec §7.6 markdown conversion → plain text (simplification, noted).
- Spec Notification hook → dropped (noted).
- Every other spec section maps to Tasks 1–8.
