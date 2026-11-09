// Where everything is stored: <repo>/.state (git-ignored).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_DIR = process.env.CREW_STATE || path.join(ROOT, '.state') // override: tests only
export const BRIDGE_PORT = Number(process.env.CREW_PORT) || 8790

const file = (name) => path.join(STATE_DIR, name)

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(name, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(file(name), JSON.stringify(data, null, 2))
}

// { hubToken, hubUsername, userId, groupId, roots: [] }
export const loadConfig = () => readJson('config.json', null)
export const saveConfig = (cfg) => writeJson('config.json', cfg)

// { bots: [{ token, username, agent }], folders: { agentName: folder } }
export const loadPool = () => readJson('pool.json', { bots: [], folders: {} })
export const savePool = (pool) => writeJson('pool.json', pool)

// Shared secret between bridge, channels and hooks.
export function getSecret() {
  const f = file('secret')
  if (!fs.existsSync(f)) {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(f, crypto.randomBytes(16).toString('hex'))
  }
  return fs.readFileSync(f, 'utf8').trim()
}

// Small helper: POST JSON to the bridge (or a channel). Returns parsed JSON.
export async function post(port, route, body, timeoutMs = 5000) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-secret': getSecret() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res.json()
}
