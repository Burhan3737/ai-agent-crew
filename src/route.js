// Pure helpers for deciding what an incoming Telegram update means.
import fs from 'node:fs'
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
