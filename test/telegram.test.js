import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkOrDoc } from '../src/telegram.js'

test('long text goes as document', () => {
  assert.equal(chunkOrDoc('hi 👋'), 'message')
  assert.equal(chunkOrDoc('x'.repeat(4000)), 'message')
  assert.equal(chunkOrDoc('x'.repeat(4001)), 'document')
})

test('empty text still sends something', () => {
  assert.equal(chunkOrDoc(''), 'message')
})
