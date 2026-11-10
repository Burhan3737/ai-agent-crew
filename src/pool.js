// The bot pool. Each bot is permanently bound to one agent name (or unused).
// Pure functions: they change the pool object; the caller saves it.

export function botFor(pool, agent) {
  return pool.bots.find((b) => b.agent === agent) ?? null
}

export function bindNew(pool, agent) {
  const existing = botFor(pool, agent)
  if (existing) return existing
  const free = pool.bots.find((b) => b.agent === null)
  if (!free) return null
  free.agent = agent
  return free
}

export function addBot(pool, token, username) {
  const known = pool.bots.find((b) => b.token === token)
  if (known) return known
  const bot = { token, username, agent: null }
  pool.bots.push(bot)
  return bot
}

// Removes bots that no longer exist on Telegram and returns them.
export async function dropDeadBots(pool, isDead) {
  const dead = []
  for (const bot of pool.bots) if (await isDead(bot.token)) dead.push(bot)
  pool.bots = pool.bots.filter((bot) => !dead.includes(bot))
  return dead
}

export function retire(pool, agent) {
  const bot = botFor(pool, agent)
  if (bot) bot.agent = null
  return bot
}
