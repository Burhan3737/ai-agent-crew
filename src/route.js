// Pure helpers for deciding what an incoming Telegram update means.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'

// Only the paired user, in their own private chat or the paired group, is obeyed.
export function isFromOwner(update, cfg) {
  const from = update.message?.from ?? update.callback_query?.from
  const chat = update.message?.chat ?? update.callback_query?.message?.chat
  if (!from || !chat || from.id !== cfg.userId) return false
  if (chat.type === 'private') return chat.id === cfg.userId
  return chat.id === cfg.groupId
}

const COMMANDS = ['list', 'bots', 'new', 'resume', 'stop', 'retire', 'addbot', 'all', 'to', 'pair']

// "/to backend run tests" -> { cmd: 'to', args: ['backend', 'run tests'] }
export function parseHub(text = '') {
  const m = text.trim().match(/^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/)
  if (!m || !COMMANDS.includes(m[1].toLowerCase())) return { cmd: 'help', args: [] }
  const cmd = m[1].toLowerCase()
  const rest = (m[2] ?? '').trim()
  if (!rest) return { cmd, args: [] }
  if (cmd === 'all') return { cmd, args: [rest] }
  if (cmd === 'to') {
    const [name] = rest.split(/\s+/)
    return { cmd, args: [name, rest.slice(name.length).trim()] }
  }
  return { cmd, args: [rest.split(/\s+/)[0]] }
}

export function stripMention(text, username) {
  // Remove "@bot" plus one following space; keep everything else (newlines, indentation).
  const re = new RegExp('@' + username + '\\b ?', 'gi')
  return text.replace(re, '').trim()
}

// In the group, an agent bot only acts on messages that @mention it or reply to it.
// Slash commands are for the hub, never forwarded to an agent.
export function groupText(message, username) {
  const text = message.text ?? ''
  if (text.startsWith('/')) return null
  const mentioned = text.toLowerCase().includes('@' + username.toLowerCase())
  const repliedTo = message.reply_to_message?.from?.username?.toLowerCase() === username.toLowerCase()
  return mentioned || repliedTo ? stripMention(text, username) : null
}

// Shorten text without splitting an emoji in half (Telegram rejects broken characters).
export const cut = (text, n) => String(text).slice(0, n).toWellFormed().replace(/�$/, '')

// The project folders typed during setup: "C:\a, C:\b".
export function parseRoots(text, exists = fs.existsSync) {
  const all = text.split(',').map((s) => s.trim()).filter(Boolean)
  return { roots: all.filter(exists), missing: all.filter((r) => !exists(r)) }
}

// The next key towards "Yes" on Claude Code's folder-trust prompt, or null if it isn't showing.
// The screen text has had its spaces removed. Goes by the latest drawing, and never guesses.
export function nextTrustKey(screen) {
  if (!screen.includes('Itrustthisfolder') || !screen.includes('Entertoconfirm')) return null
  const selected = [...screen.matchAll(/❯(?:\d\.)?(Yes,Itrust|No,exit)/g)].at(-1)?.[1]
  if (selected === 'Yes,Itrust') return '\r'
  if (selected === 'No,exit') return '\x1b[B'
  return null
}

// Bots are public, so pairing needs a code that only appears on the owner's screen.
export const pairCode = () => crypto.randomBytes(3).toString('hex').toUpperCase()

export function isPairMessage(message, code) {
  if (message?.chat?.type === 'private') return false
  const m = String(message?.text ?? '').trim().match(/^\/pair(?:@\w+)?\s+(\S+)$/i)
  return m?.[1].toUpperCase() === code
}

// Agents the bridge remembers as running that didn't come back.
export const missingAgents = (running, isOnline) =>
  Object.entries(running)
    .filter(([name]) => !isOnline(name))
    .map(([name, agent]) => ({ name, ...agent }))

// Claude arguments to reopen a conversation. An id goes on a command line, so it must look like one.
export const resumeArgs = (id) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? '') ? ['--resume', id] : []

export function setupSummary(cfg, groupTitle, botCount, autostartOn) {
  return [
    'Crew is already set up.',
    `  Hub bot: @${cfg.hubUsername}`,
    `  Group: ${groupTitle}`,
    `  Agent bots: ${botCount}`,
    `  Project folders: ${cfg.roots.join(', ')}`,
    `  Start at sign-in: ${autostartOn ? 'on' : 'off'}`,
    '',
    'To start over: crew setup --reset',
    'To change project folders: crew folders',
    'To change start at sign-in: crew autostart, or crew autostart off',
    'To add a bot: send /addbot <token> to the hub',
  ].join('\n')
}

// Immediate subfolders of each root (skipping hidden ones), sorted by name.
export function listFolders(roots) {
  const out = []
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
      .forEach((name) => out.push({ root, name, path: path.join(root, name) }))
  }
  return out
}

// Agent names become bot names, env vars and window titles: keep them plain.
export function slug(text) {
  const s = String(text).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return s || 'agent'
}

// Turns a button's index back into a folder. Anything odd -> null.
export function folderFromIndex(list, index) {
  const s = String(index)
  if (!/^\d+$/.test(s)) return null
  return list[Number(s)]?.path ?? null
}
