import test from 'node:test'
import assert from 'node:assert/strict'
import { isPairMessage, pairCode } from '../src/route.js'

const inGroup = (text) => ({ text, chat: { type: 'supergroup' } })

test('accepts /pair with the right code, in a group', () => {
  assert.ok(isPairMessage(inGroup('/pair@hub_bot 4F7K2A'), '4F7K2A'))
  assert.ok(isPairMessage(inGroup('/pair 4F7K2A'), '4F7K2A'))
  assert.ok(isPairMessage(inGroup('/pair@hub_bot 4f7k2a'), '4F7K2A'))
})

test('rejects anything without the right code', () => {
  for (const text of ['/pair', '/pair@hub_bot', '/pair@hub_bot 000000', '/pair 4F7K2A extra', '/pairing 4F7K2A', 'hello 4F7K2A', undefined]) {
    assert.ok(!isPairMessage(inGroup(text), '4F7K2A'), String(text))
  }
})

test('rejects a private chat, even with the right code', () => {
  assert.ok(!isPairMessage({ text: '/pair 4F7K2A', chat: { type: 'private' } }, '4F7K2A'))
})

test('codes are 6 characters and differ each time', () => {
  assert.match(pairCode(), /^[0-9A-F]{6}$/)
  assert.notEqual(pairCode(), pairCode())
})
