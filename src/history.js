// Reads Claude Code's saved conversations so they can be picked from the phone.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
const NOISE = /^<(system-reminder|command-|local-command)|^Caveat:/

// Claude stores each folder's conversations under a name with every symbol replaced by "-".
export function projectDir(folder, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'))
}

// The first thing the user actually said in a conversation file, or null.
export function firstMessage(text) {
  for (const row of text.split('\n')) {
    let entry
    try {
      entry = JSON.parse(row)
    } catch {
      continue
    }
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    const said = typeof content === 'string' ? content : content?.find?.((c) => c.type === 'text')?.text
    if (!said || NOISE.test(said)) continue
    return said.replace(/^<channel [^>]*>\s*|\s*<\/channel>$/g, '').trim() || null
  }
  return null
}

// Only the start of each file is read: they can be many megabytes.
function readStart(file, bytes = 1024 * 1024) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(bytes)
  const n = fs.readSync(fd, buf, 0, bytes, 0)
  fs.closeSync(fd)
  return buf.toString('utf8', 0, n)
}

// Newest first: [{ id, time, title }]
export function listConversations(folder, { home, limit = 8 } = {}) {
  const dir = projectDir(folder, home)
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => ID_FILE.test(n))
  } catch {
    return []
  }
  const newestFirst = names
    .map((n) => ({ id: n.slice(0, -6), file: path.join(dir, n), time: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.time - a.time)

  const out = []
  for (const c of newestFirst) {
    const title = firstMessage(readStart(c.file))
    if (title) out.push({ id: c.id, time: c.time, title })
    if (out.length === limit) break
  }
  return out
}
