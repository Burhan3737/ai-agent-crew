#!/usr/bin/env node
// crew — start a Claude Code session that is reachable from Telegram.
//   crew [name] [claude args...]   start an agent in the current folder
//   crew setup | status | stop-bridge
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import pty from 'node-pty'
import { ROOT, STATE_DIR, BRIDGE_PORT, loadConfig, saveConfig, loadPool, savePool, post } from './state.js'
import { addBot } from './pool.js'
import { slug, parseRoots, trustKeys } from './route.js'
import { tg, sendText, urlButton, keyboard } from './telegram.js'

const [sub, ...rest] = process.argv.slice(2)
const ask = async (q) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(q)
  rl.close()
  return answer.trim()
}

// Returns the agent list if the bridge is running, otherwise null.
const bridgeAgents = () => post(BRIDGE_PORT, '/agents', {}, 2000).then((r) => r.agents, () => null)

async function ensureBridge() {
  if (await bridgeAgents()) return
  spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await bridgeAgents()) return
  }
  console.error('Could not start the bridge — see bridge.log in the .crew folder in your home directory')
}

// ---------- crew setup ----------

async function setup() {
  if (await bridgeAgents()) return console.log('Stop the bridge first: crew stop-bridge')
  console.log('1. In Telegram, open @BotFather and create a "hub" bot (/newbot). Paste its token.')
  const hubToken = await ask('Hub bot token: ')
  const hubMe = await tg(hubToken, 'getMe')
  console.log(`   ✓ @${hubMe.username}`)

  console.log('\n2. Create a few more bots (one per agent, 5 is a good start). Paste one token per line, empty line to finish.')
  const pool = loadPool()
  for (;;) {
    const token = await ask('Agent bot token: ')
    if (!token) break
    try {
      const me = await tg(token, 'getMe')
      addBot(pool, token, me.username)
      console.log(`   ✓ @${me.username}`)
    } catch {
      console.log('   ✗ that token did not work')
    }
  }
  savePool(pool)

  const old = loadConfig()
  const previous = old?.roots?.join(',')
  console.log('\n3. Which folders hold your projects? /new can only start agents inside these.')
  let roots = []
  while (!roots.length) {
    const answer = (await ask(`Full paths, separated by commas${previous ? ` [${previous}]` : ''}: `)) || previous || ''
    const parsed = parseRoots(answer)
    parsed.missing.forEach((m) => console.log(`   ✗ not found: ${m}`))
    roots = parsed.roots
  }

  console.log('\n4. Create a Telegram group (e.g. "My Crew"), add the hub bot to it, and send /pair in the group.')
  console.log('   Waiting for /pair ...')
  let offset = 0
  let pair
  while (!pair) {
    const updates = await tg(hubToken, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
    for (const u of updates) {
      offset = u.update_id + 1
      const m = u.message
      if (m?.text?.startsWith('/pair') && m.chat.type !== 'private') pair = m
    }
  }
  await tg(hubToken, 'getUpdates', { offset, timeout: 0 }) // mark /pair as handled
  saveConfig({ hubToken, hubUsername: hubMe.username, userId: pair.from.id, groupId: pair.chat.id, roots })
  console.log(`   ✓ paired with ${pair.from.first_name} in "${pair.chat.title}"`)

  await sendText(hubToken, pair.chat.id, 'Paired ✅  For each agent bot below: tap "Open chat" (then Start) and "Add to group".')
  await sendText(hubToken, pair.chat.id, 'First, open the hub bot too:', keyboard([[urlButton('Open hub chat', `https://t.me/${hubMe.username}?start=hi`)]]))
  for (const b of pool.bots) {
    await sendText(hubToken, pair.chat.id, `@${b.username}`, keyboard([[urlButton('Open chat', `https://t.me/${b.username}?start=hi`), urlButton('Add to group', `https://t.me/${b.username}?startgroup=hi`)]]))
  }
  console.log('\nDone. Tap the buttons in the group, then start an agent with: crew <name>')
}

// ---------- crew <name> ----------

// Variables that mark "running inside another Claude session"; with them, hooks/settings are ignored.
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']

async function start(args) {
  if (!loadConfig()) {
    console.error('Not set up yet. Run: crew setup')
    process.exit(1)
  }
  const folder = process.cwd()
  let name = slug(args[0] && !args[0].startsWith('-') ? args.shift() : path.basename(folder))

  await ensureBridge()
  const running = ((await bridgeAgents()) ?? []).filter((a) => a.online).map((a) => a.name)
  while (running.includes(name)) {
    name = slug((await ask(`"${name}" is already running. Name for this agent [${name}-2]: `)) || `${name}-2`)
  }

  // Per-agent config files for Claude Code.
  const dir = path.join(STATE_DIR, 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const mcpFile = path.join(dir, `${name}.mcp.json`)
  const settingsFile = path.join(dir, `${name}.settings.json`)
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { tg: { command: 'node', args: [path.join(ROOT, 'src', 'channel.js')] } } }))
  const hook = `node "${path.join(ROOT, 'src', 'hook.js')}"`
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ['mcp__tg__reply'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } }))

  const env = { ...process.env, CREW_AGENT: name, CREW_FOLDER: folder }
  const remote = env.CREW_REMOTE === '1' // started from the phone, so nobody may be at this window
  delete env.CREW_REMOTE
  SESSION_VARS.forEach((v) => delete env[v])

  const claudeArgs = ['--mcp-config', mcpFile, '--dangerously-load-development-channels', 'server:tg', '--settings', settingsFile, '--permission-mode', 'auto', ...args]
  const p = pty.spawn('claude.exe', claudeArgs, { name: 'xterm-256color', cols: process.stdout.columns || 120, rows: process.stdout.rows || 30, cwd: folder, env })

  // Pass the terminal straight through, and press Enter once on the dev-channel warning.
  let seen = ''
  let confirmed = false
  let trustAsked = false
  let answeredHere = false

  // Asks on Telegram; the user's tap decides. A key pressed in this window wins instead.
  async function askTrust(keys) {
    const { answer } = await post(BRIDGE_PORT, '/trust', { name, folder }, 10 * 60 * 1000).catch(() => ({}))
    if (answeredHere) return
    if (answer === 'no') return p.kill()
    if (answer === 'yes') keys.forEach((key, i) => setTimeout(() => p.write(key), i * 200))
  }

  p.onData((data) => {
    process.stdout.write(data)
    if (confirmed) return
    seen = (seen + data.replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '').replace(/\s/g, '')).slice(-5000)
    const keys = remote && !trustAsked ? trustKeys(seen) : null
    if (keys) {
      trustAsked = true
      askTrust(keys)
    }
    if (seen.includes('Iamusingthisforlocaldevelopment')) {
      confirmed = true
      setTimeout(() => p.write('\r'), 300)
    }
  })
  p.onExit(({ exitCode }) => process.exit(exitCode))
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (d) => {
    if (trustAsked) answeredHere = true
    p.write(d.toString())
  })
  process.stdout.on('resize', () => p.resize(process.stdout.columns, process.stdout.rows))
}

// ---------- main ----------

if (sub === 'setup') await setup()
else if (sub === 'status') {
  const agents = await bridgeAgents()
  if (!agents) console.log('Bridge is not running.')
  else {
    console.log('Bridge is running.')
    agents.forEach((a) => console.log(`  ${a.online ? 'online ' : 'offline'}  ${a.name}  ${a.folder ?? ''}`))
  }
} else if (sub === 'stop-bridge') {
  if (!(await bridgeAgents())) console.log('Bridge is not running.') // never kill a stale pid
  else try {
    process.kill(Number(fs.readFileSync(path.join(STATE_DIR, 'bridge.pid'), 'utf8')))
    console.log('Bridge stopped.')
  } catch {
    console.log('Bridge is not running.')
  }
} else await start(sub ? [sub, ...rest] : [])
