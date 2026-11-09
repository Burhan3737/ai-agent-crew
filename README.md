# Crew

Your Claude Code agents, on Telegram.

Talk to the Claude Code sessions on this PC from Telegram. Each session ("agent") gets its own
Telegram bot, so it has a private chat with you, and all agents sit together in one group.

```
Phone (Telegram)  <->  bridge (this PC)  <->  each Claude session started with `crew`
```

## One-time setup

1. Install Crew (you need Node 22 and Claude Code):
   ```
   npm install -g github:Burhan3737/ai-agent-crew
   ```
   Run the same command later to update.
2. In Telegram, open **@BotFather** and create bots with `/newbot`:
   - one **hub** bot (e.g. "Crew Hub"): it handles commands;
   - a few **agent** bots (5 is a good start). Each agent gets one bot for good.
3. Run `crew setup`, paste the tokens when asked, and list the folders that hold your projects.
4. When asked, create a Telegram group (e.g. "My Crew"), add the hub bot, and send `/pair`
   in the group.
5. In the group, the hub posts a button to open its own chat (tap it, then Start), and two buttons for
   every agent bot. Tap **Open chat** (then Start)
   and **Add to group** once for each one.

## Daily use

**On the PC:** in a project folder, run `crew` (the agent is named after the folder) or
`crew <name>`. Extra arguments go to `claude`, e.g. `crew backend --continue`.

**Moving a session that's already running:** exit it (`/exit`), then run
`crew <name> --continue` in the same folder. It keeps its history and is now on Telegram.

**On the phone:**
- **Private chat with an agent's bot:** talk to that agent.
- **In the group:** `@its_bot do something` (or reply to one of its messages) and it replies in the group.
- **Hub commands:** send them in the hub's private chat, or in the group by picking them from the `/` command menu (Telegram adds `@hub` so the hub gets them).

| Command | What it does |
|---|---|
| `/list` | Agents (🟢 running) with buttons that open their chats |
| `/new [name]` | Pick a project folder and start an agent there |
| `/resume [name]` | Reopen a closed agent: pick from its past conversations |
| `/stop <name>` | Stop an agent |
| `/all <message>` | Message every running agent |
| `/to <name> <message>` | Message one agent from here (for agents with no bot yet) |
| `/addbot <token>` | Add a new bot from @BotFather. Use the hub's private chat, never the group |
| `/bots` | Which bot belongs to which agent |
| `/retire <name>` | Free an agent's bot (clear its chat first) |

**Reopening a closed agent:** message its bot (or send `/resume`) and tap **▶ Resume**. You'll see the
last 8 conversations from that agent's folder, newest first, with date and first message. Tap one and
it reopens with its full history, on the same bot. **🆕 Start fresh** starts a new conversation instead.
The list covers everything in that folder, including conversations from plain `claude` or another agent there.

**What you'll get:**
- the agent's replies;
- **✅ done** messages when it finishes something you started at the PC;
- **⚠️ Allow / Deny** buttons when it needs permission. Agents run in auto mode, so this is rare.

**Good to know:**
- The PC must be on and awake (locked is fine). Agents started from the phone open in a
  minimized window. Closing the window stops that agent.
- If you run out of bots, a new agent still starts and talks through the hub
  (`/to <name> …`) until you `/addbot`.
- The first time you start an agent from the phone in a folder Claude hasn't been told to trust, the
  hub asks in the group, with **Trust** and **Cancel** buttons. Cancel closes that agent.
- `crew status` shows the bridge and agents. `crew stop-bridge` stops the bridge. The next `crew` you run
  starts it again. If the PC restarts, run `crew` once (or start an agent) to bring it back.
- One session per name. Folders with the same name in both roots (e.g. two `api` folders) would
  share one bot, so give one of them its own name: `crew work-api`.
- If an agent bot doesn't react to `@mentions` in the group, open @BotFather → `/setprivacy` →
  pick that bot → **Disable**. It still only acts on messages that mention it or reply to it.
- `/new` only offers folders inside the project folders you chose during setup. Run `crew setup`
  again to change them.

## Safety

- Only your Telegram account, in your private chats and the paired group, is obeyed.
  Everything else is ignored.
- Bot tokens and settings live in the `.crew` folder in your home directory. Never share that folder.
- Each session starts with Claude Code's `--dangerously-load-development-channels` flag. Custom
  channels need it during the research preview. `crew` confirms the warning screen for you.

## Tests

`npm test`
