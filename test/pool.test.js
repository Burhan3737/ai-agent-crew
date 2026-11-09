import test from 'node:test'
import assert from 'node:assert/strict'
import { bindNew, botFor, retire, addBot } from '../src/pool.js'

test('new agent binds first unused bot, same agent keeps it', () => {
  const p = { bots: [{ token: 'a', username: 'b1', agent: null }, { token: 'b', username: 'b2', agent: null }] }
  assert.equal(bindNew(p, 'backend').token, 'a')
  assert.equal(bindNew(p, 'backend').token, 'a')
  assert.equal(bindNew(p, 'docs').token, 'b')
  assert.equal(bindNew(p, 'api'), null)
  assert.equal(botFor(p, 'docs').token, 'b')
})

test('retire frees the bot; a new name may then take it', () => {
  const p = { bots: [{ token: 'a', username: 'b1', agent: 'backend' }] }
  assert.equal(retire(p, 'backend').token, 'a')
  assert.equal(botFor(p, 'backend'), null)
  assert.equal(bindNew(p, 'docs').token, 'a')
})

test('addBot ignores duplicate tokens', () => {
  const p = { bots: [] }
  addBot(p, 't', 'u')
  addBot(p, 't', 'u')
  assert.equal(p.bots.length, 1)
})
