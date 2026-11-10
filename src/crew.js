#!/usr/bin/env node
// crew — start a Claude Code session that is reachable from Telegram.
//   crew [name] [claude args...]   start an agent in the current folder
//   crew setup [--reset] | folders | autostart [off] | status | stop-bridge
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline/promises'
import pty from 'node-pty'
import { ROOT, STATE_DIR, BRIDGE_PORT, loadConfig, saveConfig, loadPool, savePool, post } from './state.js'
import { addBot, dropDeadBots } from './pool.js'
import { slug, parseRoots, nextTrustKey, setupSummary, pairCode, isPairMessage } from './route.js'
import { isAutostartOn, enableAutostart, disableAutostart } from './autostart.js'
import { tg, sendText, urlButton, keyboard } from './telegram.js'

const [sub, ...rest] = process.argv.slice(2)

// One reader for the whole run, so several lines pasted at once aren't lost.
let reader
let lines
async function ask(question) {
  if (!reader) {
    reader = readline.createInterface({ input: process.stdin })
    lines = reader[Symbol.asyncIterator]()
  }
  process.stdout.write(question)
  const { value, done } = await lines.next()
  if (done) process.exit(1)
  return value.trim()
}

function doneAsking() {
  reader?.close()
  reader = null
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

// Returns true if it stopped a running bridge. Asks the bridge first, so it never kills a stale pid.
async function stopBridge() {
  if (!(await bridgeAgents())) return false
  try {
    process.kill(Number(fs.readFileSync(path.join(STATE_DIR, 'bridge.pid'), 'utf8')))
  } catch {
    return false
  }
  for (let i = 0; i < 20 && (await bridgeAgents()); i++) await new Promise((r) => setTimeout(r, 250))
  return true
}

// Only Telegram's "Unauthorized" means gone: a network problem must not remove a bot.
const isDeadToken = (token) => tg(token, 'getMe').then(() => false, (err) => /Unauthorized/.test(err.message))

// ---------- crew setup ----------

async function askRoots(previous, label = '') {
  console.log(label + 'Which folders hold your projects? /new can only start agents inside these.')
  for (;;) {
    const answer = (await ask(`Full paths, separated by commas${previous ? ` [${previous}]` : ''}: `)) || previous || ''
    const parsed = parseRoots(answer)
    parsed.missing.forEach((m) => console.log(`   ✗ not found: ${m}`))
    if (parsed.roots.length) return parsed.roots
  }
}

async function showSetup(cfg) {
  const title = await tg(cfg.hubToken, 'getChat', { chat_id: cfg.groupId }).then((c) => c.title, () => '(could not reach Telegram)')
  console.log(setupSummary(cfg, title, loadPool().bots.length, isAutostartOn()))
}

async function setup() {
  const old = loadConfig()
  if (old && !rest.includes('--reset')) return showSetup(old)
  await stopBridge() // only one program can read a bot's messages at a time

  console.log('1. In Telegram, open @BotFather and create a "hub" bot (/newbot). Paste its token.')
  let hubToken
  let hubMe
  while (!hubMe) {
    hubToken = (await ask(`Hub bot token${old ? ' [Enter to keep current]' : ''}: `)) || old?.hubToken
    if (hubToken) hubMe = await tg(hubToken, 'getMe').catch(() => console.log('   ✗ that token did not work'))
  }
  console.log(`   ✓ @${hubMe.username}`)

  const pool = loadPool()
  for (const bot of await dropDeadBots(pool, isDeadToken)) console.log(`   ✗ removed @${bot.username} (deleted on Telegram)`)
  console.log(`\n2. Create a bot for each agent (5 is a good start). You have ${pool.bots.length}. Paste one token per line, empty line to finish.`)
  for (;;) {
    const token = await ask('Agent bot token: ')
    if (!token) break
    const me = token === hubToken ? null : await tg(token, 'getMe').catch(() => null)
    if (me) addBot(pool, token, me.username)
    console.log(me ? `   ✓ @${me.username}` : '   ✗ that token did not work')
  }
  savePool(pool)

  const roots = await askRoots(old?.roots?.join(','), '\n3. ')

  const auto = await ask('\n4. Start Crew automatically when you sign in to Windows? [Y/n]: ')
  auto.toLowerCase().startsWith('n') ? disableAutostart() : enableAutostart()

  // Same hub bot: its group still works, so only pair again if asked to.
  if (old?.hubToken === hubToken && !(await ask('\n5. Pair a different group? [y/N]: ')).toLowerCase().startsWith('y')) {
    saveConfig({ ...old, roots })
    await ensureBridge()
    return console.log('\nDone. Your settings are saved and Crew is running.')
  }

  const code = pairCode()
  console.log(`\n5. Create a Telegram group (e.g. "My Crew"), add the hub bot to it, and send this in the group:\n\n   /pair@${hubMe.username} ${code}\n`)
  console.log('   Waiting for /pair ...')
  let offset = 0
  let pair
  while (!pair) {
    const updates = await tg(hubToken, 'getUpdates', { offset, timeout: 30, allowed_updates: ['message'] })
    for (const u of updates) {
      offset = u.update_id + 1
      const m = u.message
      if (isPairMessage(m, code)) pair = m
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
  await ensureBridge()
  console.log('\nDone. Crew is running. Tap the buttons in the group, then send /new to the hub or run: crew <name>')
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

  doneAsking()

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
  async function askTrust() {
    const { answer } = await post(BRIDGE_PORT, '/trust', { name, folder }, 10 * 60 * 1000).catch(() => ({}))
    if (answeredHere) return
    if (answer === 'no') return p.kill()
    if (answer === 'yes') pressYes()
  }

  // Looks at the screen before every key, because the prompt can reset its selection while it's up.
  function pressYes() {
    let tries = 0
    const timer = setInterval(() => {
      const key = nextTrustKey(seen)
      if (key) p.write(key)
      if (!key || key === '\r' || ++tries > 20) clearInterval(timer)
    }, 500)
  }

  p.onData((data) => {
    process.stdout.write(data)
    if (confirmed) return
    seen = (seen + data.replace(/\x1b\[[0-9;?<>]*[a-zA-Z]/g, '').replace(/\s/g, '')).slice(-5000)
    if (remote && !trustAsked && nextTrustKey(seen)) {
      trustAsked = true
      askTrust()
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
  process.stdin.resume()
  process.stdout.on('resize', () => p.resize(process.stdout.columns, process.stdout.rows))
}

// ---------- main ----------

if (sub === 'setup') {
  await setup()
  doneAsking()
} else if (sub === 'folders') {
  const cfg = loadConfig()
  if (!cfg) console.log('Not set up yet. Run: crew setup')
  else {
    saveConfig({ ...cfg, roots: await askRoots(cfg.roots.join(',')) })
    doneAsking()
    console.log('Saved.')
  }
} else if (sub === 'autostart') {
  if (rest[0] === 'off') disableAutostart()
  else enableAutostart()
  console.log(`Start at sign-in is ${isAutostartOn() ? 'on' : 'off'}.`)
} else if (sub === 'status') {
  const agents = await bridgeAgents()
  if (!agents) console.log('Bridge is not running.')
  else {
    console.log('Bridge is running.')
    agents.forEach((a) => console.log(`  ${a.online ? 'online ' : 'offline'}  ${a.name}  ${a.folder ?? ''}`))
  }
} else if (sub === 'stop-bridge') {
  console.log((await stopBridge()) ? 'Bridge stopped.' : 'Bridge is not running.')
} else await start(sub ? [sub, ...rest] : [])
