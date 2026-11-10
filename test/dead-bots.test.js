import test from 'node:test'
import assert from 'node:assert/strict'
import { dropDeadBots, botFor, bindNew } from '../src/pool.js'

const pool = () => ({
  bots: [
    { token: 'alive', username: 'a_bot', agent: 'backend' },
    { token: 'dead-bound', username: 'b_bot', agent: 'docs' },
    { token: 'dead-free', username: 'c_bot', agent: null },
  ],
})
const isDead = async (token) => token.startsWith('dead')

test('dead bots are removed and returned; live ones stay', async () => {
  const p = pool()
  const dropped = await dropDeadBots(p, isDead)
  assert.deepEqual(dropped.map((b) => b.username), ['b_bot', 'c_bot'])
  assert.deepEqual(p.bots.map((b) => b.username), ['a_bot'])
})

test('an agent that lost its bot can get a new one, and dead bots are never handed out', async () => {
  const p = pool()
  await dropDeadBots(p, isDead)
  assert.equal(botFor(p, 'docs'), null)
  assert.equal(bindNew(p, 'docs'), null) // none free yet, rather than the dead one
})

test('nothing dead means nothing changes', async () => {
  const p = pool()
  assert.deepEqual(await dropDeadBots(p, async () => false), [])
  assert.equal(p.bots.length, 3)
})
