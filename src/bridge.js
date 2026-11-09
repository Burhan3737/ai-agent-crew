// The bridge: one process that owns every Telegram bot and knows every agent.
//   Telegram  <->  bridge  <->  channel.js inside each Claude session
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { ROOT, STATE_DIR, BRIDGE_PORT, loadConfig, loadPool, savePool, getSecret, post } from './state.js'
import { botFor, bindNew, addBot, retire } from './pool.js'
import { isFromOwner, parseHub, groupText, listFolders, folderFromIndex, slug, cut } from './route.js'
import { tg, sendText, poll, button, urlButton, keyboard } from './telegram.js'
import { listConversations } from './history.js'

const cfg = loadConfig()
if (!cfg) {
  console.error('Not set up yet. Run: crew setup')
  process.exit(1)
}
const pool = loadPool()
pool.folders ??= {}
const hub = cfg.hubToken
const secret = getSecret()
const CREW_CMD = path.join(ROOT, 'bin', 'crew.cmd')

const agents = new Map() // name -> { folder, port, pid, lastSeen, replied }
const permissions = new Map() // request_id -> agent name
const trustAsks = new Map() // id -> function that answers a waiting folder-trust question
let trustId = 0
let newRequest = { id: 0, name: null, folders: [] } // the last /new folder list shown
let resumeRequest = { id: 0, name: null, folder: null, items: [] } // the last conversation list shown

const log = (msg) => fs.appendFileSync(path.join(STATE_DIR, 'bridge.log'), `${new Date().toISOString()} ${msg}\n`)
const safe = (p) => Promise.resolve(p).catch((err) => log('telegram error: ' + err.message))
const online = (name) => agents.has(name) && Date.now() - agents.get(name).lastSeen < 45000

// ---------- sending ----------

// To the agent's private chat (or via the hub, prefixed, if it has no bot yet).
function toUser(name, text, extra = {}) {
  const bot = botFor(pool, name)
  if (bot) return safe(sendText(bot.token, cfg.userId, text, extra))
  return safe(sendText(hub, cfg.userId, `[${name}] ${text}`, extra))
}

function toChat(name, chatId, text) {
  if (Number(chatId) !== cfg.groupId) return toUser(name, text)
  const bot = botFor(pool, name)
  if (bot) return safe(sendText(bot.token, cfg.groupId, text))
  return safe(sendText(hub, cfg.groupId, `[${name}] ${text}`))
}

const hubSay = (chatId, text, extra = {}) => safe(sendText(hub, chatId, text, extra))

// To the agent's session.
async function forward(name, text, chatId) {
  if (!online(name)) return false
  const a = agents.get(name)
  a.replied = false
  await post(a.port, '/message', { text, chat_id: chatId, from: 'telegram' }).catch(() => {})
  return true
}

// ---------- agents coming and going ----------

async function comeOnline(name, folder) {
  pool.folders[name] = folder
  let bot = botFor(pool, name)
  if (!bot) {
    bot = bindNew(pool, name)
    if (bot) await safe(tg(bot.token, 'setMyName', { name }))
  }
  savePool(pool)
  log(`online ${name}`)
  await toUser(name, `🟢 ${name} is online — ${folder}`)
  await hubSay(cfg.groupId, `🟢 ${name} is online`)
  if (!bot) {
    await hubSay(cfg.userId, `No free bot for "${name}". Create one in @BotFather and send me /addbot <token>. Until then, talk to it here with /to ${name} <message>.`)
  }
}

async function goOffline(name) {
  agents.delete(name)
  log(`offline ${name}`)
  await toUser(name, `🔴 ${name} went offline`)
}

setInterval(() => {
  for (const name of agents.keys()) if (!online(name)) goOffline(name)
}, 15000)

// Opens a minimized terminal window running "crew <name>" in that folder. Returns false if it can't.
function launch(folder, name, claudeArgs = []) {
  name = slug(name)
  if (!fs.existsSync(folder)) return false
  const cmd = `/c start "${name}" /min cmd /c ""${CREW_CMD}" ${name} ${claudeArgs.join(' ')}"`
  spawn('cmd.exe', [cmd], { cwd: folder, detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env: { ...process.env, CREW_REMOTE: '1' } })
    .on('error', (err) => log('launch failed: ' + err.message))
    .unref()
  log(`launch ${name} in ${folder}`)
  return true
}

// ---------- HTTP API for channels, hooks and crew ----------

const routes = {
  async '/register'({ name, folder, port, pid }) {
    const wasOnline = online(name)
    // Only one session per name: a second one with the same name is refused.
    if (wasOnline && agents.get(name).pid !== pid) return { ok: false, error: 'name already in use' }
    agents.set(name, { ...agents.get(name), folder, port, pid, lastSeen: Date.now() })
    if (!wasOnline) await comeOnline(name, folder)
    return { ok: true, name }
  },
  async '/unregister'({ name }) {
    if (agents.has(name)) await goOffline(name)
    return { ok: true }
  },
  async '/reply'({ name, chat_id, text }) {
    if (agents.has(name)) agents.get(name).replied = true
    await toChat(name, chat_id, text)
    return { ok: true }
  },
  async '/permission'({ name, request_id, tool_name, description, input_preview }) {
    permissions.set(request_id, name)
    const text = `⚠️ ${name} wants to use ${tool_name}: ${description}\n\n${cut(input_preview, 1500)}`
    await toUser(name, text, keyboard([[button('✅ Allow', `p:${request_id}:a`), button('❌ Deny', `p:${request_id}:d`)]]))
    return { ok: true }
  },
  // Asked by crew when an agent started from the phone is stuck on Claude's trust prompt.
  // Goes through the hub in the group, because a brand-new agent has no bot yet.
  async '/trust'({ name, folder }) {
    const id = String(++trustId)
    const answer = new Promise((resolve) => {
      trustAsks.set(id, resolve)
      setTimeout(() => trustAsks.delete(id) && resolve('timeout'), 9 * 60 * 1000)
    })
    const text = `🔒 ${name} needs you to trust this folder before it can start:\n${folder}\n\nClaude will be able to read, edit and run files there.`
    await hubSay(cfg.groupId, text, keyboard([[button('✅ Trust', `t:${id}:y`), button('❌ Cancel', `t:${id}:n`)]]))
    return { answer: await answer }
  },
  async '/hook'({ name, last_assistant_message }) {
    const a = agents.get(name)
    if (!a) return { ok: true }
    if (a.replied) a.replied = false // already answered on the phone; don't notify twice
    else if (last_assistant_message) await toUser(name, '✅ ' + cut(last_assistant_message, 3500))
    return { ok: true }
  },
  async '/agents'() {
    const names = new Set([...agents.keys(), ...pool.bots.filter((b) => b.agent).map((b) => b.agent)])
    return { agents: [...names].map((name) => ({ name, folder: pool.folders[name], online: online(name) })) }
  },
}

const server = http.createServer(async (req, res) => {
  const reply = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
  if (req.headers['x-secret'] !== secret) return reply(403, { ok: false, error: 'forbidden' })
  const handler = routes[req.url]
  if (!handler) return reply(404, { ok: false, error: 'not found' })
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    reply(200, await handler(JSON.parse(body || '{}')))
  } catch (err) {
    log('route error: ' + err.message)
    reply(500, { ok: false, error: err.message })
  }
})

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? 'Bridge is already running.' : err.message)
  process.exit(1)
})

// ---------- Telegram: agent bots ----------

async function onAgentBot(bot, u) {
  if (!isFromOwner(u, cfg)) return
  if (u.callback_query) return onButton(bot.token, u.callback_query)
  const m = u.message
  if (!m?.text) return
  const name = bot.agent
  if (m.text.startsWith('/start')) {
    return safe(sendText(bot.token, m.chat.id, name ? `Hi, I'm ${name}.` : 'Hi! I am a free agent slot.'))
  }
  if (!name) return safe(sendText(bot.token, m.chat.id, 'This bot has no agent yet.'))
  const text = m.chat.id === cfg.groupId ? groupText(m, bot.username) : m.text
  if (!text) return
  if (!(await forward(name, text, m.chat.id))) {
    await safe(sendText(bot.token, m.chat.id, `${name} is offline.`, keyboard([[button('▶ Resume', `h:${name}`), button('🆕 Start fresh', `s:${name}`)]])))
  }
}

// ---------- Telegram: hub bot ----------

async function onHub(u) {
  if (!isFromOwner(u, cfg)) return
  if (u.callback_query) return onButton(hub, u.callback_query)
  const m = u.message
  if (!m?.text) return
  const chat = m.chat.id

  const { cmd, args } = parseHub(m.text)
  const [first, second] = args

  if (cmd === 'list') {
    const names = (await routes['/agents']()).agents.sort((a, b) => b.online - a.online)
    if (!names.length) return hubSay(chat, 'No agents yet. Start one with /new.')
    const lines = names.map((a) => `${a.online ? '🟢' : '⚪'} ${a.name}${botFor(pool, a.name) ? '' : ' (no bot — use /to)'}`)
    const rows = names
      .filter((a) => botFor(pool, a.name))
      .map((a) => [urlButton(`💬 ${a.name}`, `https://t.me/${botFor(pool, a.name).username}`)])
    return hubSay(chat, lines.join('\n'), keyboard(rows))
  }

  if (cmd === 'bots') {
    const lines = pool.bots.map((b) => `@${b.username} → ${b.agent ?? 'unused'}`)
    return hubSay(chat, lines.join('\n') || 'No bots. Add one with /addbot <token>.')
  }

  if (cmd === 'new') {
    const all = listFolders(cfg.roots)
    const folders = all.slice(0, 60)
    newRequest = { id: newRequest.id + 1, name: first ? slug(first) : null, folders }
    const rows = []
    folders.forEach((f, i) => {
      const label = `${path.basename(f.root)}/${f.name}`
      if (i % 2 === 0) rows.push([button(label, `n:${newRequest.id}:${i}`)])
      else rows.at(-1).push(button(label, `n:${newRequest.id}:${i}`))
    })
    const more = all.length > 60 ? ` (first 60 of ${all.length} shown)` : ''
    return hubSay(chat, `Which project?${more}`, keyboard(rows))
  }

  if (cmd === 'resume') {
    if (first) return showConversations(hub, chat, first)
    const offline = (await routes['/agents']()).agents.filter((a) => !a.online && a.folder)
    if (!offline.length) return hubSay(chat, 'No closed agents to resume.')
    return hubSay(chat, 'Resume which agent?', keyboard(offline.map((a) => [button(a.name, `h:${a.name}`)])))
  }

  if (cmd === 'stop') {
    if (!online(first)) return hubSay(chat, `${first ?? 'That agent'} is not running.`)
    return hubSay(chat, `Stop ${first}?`, keyboard([[button(`⏹ Stop ${first}`, `x:${first}`)]]))
  }

  if (cmd === 'retire') {
    if (!botFor(pool, first)) return hubSay(chat, `${first ?? 'That agent'} has no bot.`)
    if (online(first)) return hubSay(chat, `Stop ${first} first (/stop ${first}).`)
    return hubSay(
      chat,
      `This frees ${first}'s bot for a different agent.\nFirst open ${first}'s chat → ⋮ → Clear history, so the next agent starts clean. Then tap Confirm.`,
      keyboard([[button('Confirm', `r:${first}`)]]),
    )
  }

  if (cmd === 'addbot') {
    if (!first) return hubSay(chat, 'Usage: /addbot <token from @BotFather>')
    if (first === hub) return hubSay(chat, 'That is the hub bot itself — create a new bot in @BotFather.')
    let me
    try {
      me = await tg(first, 'getMe')
    } catch {
      return hubSay(chat, 'That token did not work.')
    }
    const bot = addBot(pool, first, me.username)
    savePool(pool)
    startPolling(bot)
    await hubSay(
      chat,
      `Added @${me.username}. Tap both buttons once, then delete your message with the token.`,
      keyboard([[urlButton('1. Open its chat', `https://t.me/${me.username}?start=hi`)], [urlButton('2. Add to group', `https://t.me/${me.username}?startgroup=hi`)]]),
    )
    // Give it to the first running agent that has no bot.
    const waiting = [...agents.keys()].find((n) => online(n) && !botFor(pool, n))
    if (waiting) {
      const given = bindNew(pool, waiting)
      savePool(pool)
      await safe(tg(given.token, 'setMyName', { name: waiting }))
      await toUser(waiting, `🟢 ${waiting} now has its own chat.`)
    }
    return
  }

  if (cmd === 'all') {
    if (!first) return hubSay(chat, 'Usage: /all <message>')
    const names = [...agents.keys()].filter(online)
    for (const name of names) await forward(name, first, chat)
    return hubSay(chat, names.length ? `Sent to ${names.join(', ')}.` : 'No agents are running.')
  }

  if (cmd === 'to') {
    if (!second) return hubSay(chat, 'Usage: /to <name> <message>')
    if (!(await forward(first, second, chat))) return hubSay(chat, `${first} is not running.`)
    return
  }

  if (cmd === 'pair') return hubSay(chat, 'Already paired.')

  return hubSay(
    chat,
    [
      '/list — agents, tap one to open its chat',
      '/new [name] — start an agent in a project',
      "/resume [name] — reopen a closed agent's conversation",
      '/stop <name> — stop an agent',
      '/all <message> — message every running agent',
      '/to <name> <message> — message one agent from here',
      '/addbot <token> — add a bot from @BotFather',
      '/bots — which bot belongs to which agent',
      '/retire <name> — free an agent\'s bot',
    ].join('\n'),
  )
}

// ---------- buttons ----------

async function onButton(token, cq) {
  const [kind, value, extra] = String(cq.data).split(':')
  const answer = (text) => safe(tg(token, 'answerCallbackQuery', { callback_query_id: cq.id, text }))
  const chat = cq.message.chat.id

  if (kind === 'p') {
    const name = permissions.get(value)
    if (!name || !online(name)) return answer('Already answered or expired')
    permissions.delete(value)
    const behavior = extra === 'a' ? 'allow' : 'deny'
    await post(agents.get(name).port, '/verdict', { request_id: value, behavior }).catch(() => {})
    await safe(tg(token, 'editMessageText', { chat_id: chat, message_id: cq.message.message_id, text: `${cq.message.text}\n\n→ ${behavior === 'allow' ? '✅ Allowed' : '❌ Denied'}` }))
    return answer(behavior === 'allow' ? 'Allowed' : 'Denied')
  }

  if (kind === 's') {
    if (online(value)) return answer(`${value} is already running`)
    const folder = pool.folders[value]
    if (!folder) return answer('I do not know its folder — use /new')
    if (!launch(folder, value)) return answer(`Folder not found: ${folder}`)
    return answer(`Starting ${value}…`)
  }

  if (kind === 't') {
    const resolve = trustAsks.get(value)
    if (!resolve) return answer('Already answered or expired')
    trustAsks.delete(value)
    resolve(extra === 'y' ? 'yes' : 'no')
    await safe(tg(token, 'editMessageText', { chat_id: chat, message_id: cq.message.message_id, text: `${cq.message.text}\n\n→ ${extra === 'y' ? '✅ Trusted' : '❌ Cancelled'}` }))
    return answer(extra === 'y' ? 'Trusted' : 'Cancelled')
  }

  if (kind === 'h') {
    await answer('')
    return showConversations(token, chat, value)
  }

  if (kind === 'o') {
    const { name, folder, items } = resumeRequest
    const picked = value === String(resumeRequest.id) ? items[Number(extra)] : null
    if (!picked) return answer('That list is out of date — ask again')
    if (online(name)) return answer(`${name} is already running`)
    if (!launch(folder, name, ['--resume', picked.id])) return answer(`Folder not found: ${folder}`)
    return answer(`Resuming ${name}…`)
  }

  if (kind === 'n') {
    const folder = value === String(newRequest.id) ? folderFromIndex(newRequest.folders, extra) : null
    if (!folder) return answer('That list is out of date — send /new again')
    await answer('')
    return startAgent(chat, folder, newRequest.name ?? slug(path.basename(folder)))
  }

  if (kind === 'x') {
    const a = agents.get(value)
    if (!a || !online(value)) return answer(`${value} is not running`)
    execFile('taskkill', ['/PID', String(a.pid), '/T', '/F'], () => {})
    await goOffline(value)
    return answer(`Stopped ${value}`)
  }

  if (kind === 'r') {
    if (online(value)) return answer(`Stop ${value} first`)
    const bot = retire(pool, value)
    if (!bot) return answer('Nothing to retire')
    delete pool.folders[value]
    savePool(pool)
    await safe(tg(bot.token, 'setMyName', { name: '💤 unused' }))
    return answer(`${value} retired; its bot is free`)
  }

  return answer('')
}

// Shows an agent's past conversations as buttons, newest first.
function showConversations(token, chat, name) {
  const say = (text, extra) => safe(sendText(token, chat, text, extra))
  if (online(name)) return say(`${name} is already running.`)
  const folder = pool.folders[name]
  if (!folder) return say(`I don't know ${name}'s folder. Use /new.`)
  const items = listConversations(folder)
  if (!items.length) return say(`No saved conversations in ${folder}.`)
  resumeRequest = { id: resumeRequest.id + 1, name, folder, items }
  const rows = items.map((c, i) => {
    const when = new Date(c.time).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return [button(`${when} · ${cut(c.title.replace(/s+/g, ' '), 40)}`, `o:${resumeRequest.id}:${i}`)]
  })
  return say(`Which conversation should ${name} continue?`, keyboard(rows))
}

function startAgent(chat, folder, name) {
  if (online(name)) return hubSay(chat, `"${name}" is already running. Send /new <another-name>, e.g. /new ${name}-2`)
  if (!launch(folder, name)) return hubSay(chat, `Folder not found: ${folder}`)
  return hubSay(chat, `Starting ${name} in ${folder}… it will message you when it's ready.`)
}

// ---------- start ----------

function startPolling(bot) {
  if (bot.polling) return
  Object.defineProperty(bot, 'polling', { value: true, enumerable: false }) // not saved to disk
  poll(bot.token, (u) => onAgentBot(bot, u))
}

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  fs.writeFileSync(path.join(STATE_DIR, 'bridge.pid'), String(process.pid))
  log(`bridge started (pid ${process.pid})`)
  // Command menu for the hub. Picking a command from it adds @hub, so it works in the group too.
  const commands = Object.entries({
    list: 'Agents — tap one to open its chat',
    new: 'Start an agent in a project',
    resume: "Reopen a closed agent's conversation",
    stop: 'Stop an agent',
    all: 'Message every running agent',
    to: 'Message one agent from here',
    addbot: 'Add a bot (use in this private chat)',
    bots: 'Which bot belongs to which agent',
    retire: "Free an agent's bot",
  }).map(([command, description]) => ({ command, description }))
  safe(tg(hub, 'setMyCommands', { commands }))
  poll(hub, onHub)
  pool.bots.forEach(startPolling)
})
