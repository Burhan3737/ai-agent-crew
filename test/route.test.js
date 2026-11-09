import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isFromOwner, parseHub, stripMention, listFolders, folderFromIndex } from '../src/route.js'

const cfg = { userId: 1, groupId: -100 }
const msg = (fromId, chatId, type = 'private') => ({ message: { from: { id: fromId }, chat: { id: chatId, type }, text: 'x' } })

test('owner in private chat or paired group is accepted', () => {
  assert.ok(isFromOwner(msg(1, 1), cfg))
  assert.ok(isFromOwner(msg(1, -100, 'supergroup'), cfg))
})

test('anyone else is ignored', () => {
  assert.ok(!isFromOwner(msg(2, 2), cfg))
  assert.ok(!isFromOwner(msg(2, -100, 'supergroup'), cfg))
  assert.ok(!isFromOwner(msg(1, -999, 'supergroup'), cfg))
  assert.ok(!isFromOwner({}, cfg))
})

test('callback queries are checked too', () => {
  const cb = (from) => ({ callback_query: { from: { id: from }, message: { chat: { id: -100, type: 'supergroup' } } } })
  assert.ok(!isFromOwner(cb(2), cfg))
  assert.ok(isFromOwner(cb(1), cfg))
})

test('hub commands parse', () => {
  assert.deepEqual(parseHub('/to backend run tests'), { cmd: 'to', args: ['backend', 'run tests'] })
  assert.deepEqual(parseHub('/list@ClaudeHubBot'), { cmd: 'list', args: [] })
  assert.deepEqual(parseHub('/all hi there'), { cmd: 'all', args: ['hi there'] })
  assert.deepEqual(parseHub('/stop backend'), { cmd: 'stop', args: ['backend'] })
  assert.deepEqual(parseHub('/new'), { cmd: 'new', args: [] })
  assert.equal(parseHub('hello').cmd, 'help')
  assert.equal(parseHub('/rm -rf').cmd, 'help')
})

test('stripMention', () => {
  assert.equal(stripMention('@Agent1_Bot run it', 'agent1_bot'), 'run it')
  assert.equal(stripMention('please @agent1_bot run', 'agent1_bot'), 'please run')
  assert.equal(stripMention('@agent1_bot fix:\n  line1\n  line2', 'agent1_bot'), 'fix:\n  line1\n  line2')
})

test('listFolders lists subfolders of existing roots only', () => {
  const root = (fs.mkdirSync('.agentTempWork', { recursive: true }), fs.mkdtempSync(path.join('.agentTempWork', 'crew-')))
  fs.mkdirSync(path.join(root, 'b'))
  fs.mkdirSync(path.join(root, 'a'))
  fs.mkdirSync(path.join(root, '.hidden'))
  fs.writeFileSync(path.join(root, 'file.txt'), '')
  const list = listFolders([root, path.join(root, 'missing')])
  assert.deepEqual(list.map((f) => f.name), ['a', 'b'])
  assert.equal(list[0].path, path.join(root, 'a'))
  fs.rmSync(root, { recursive: true })
})

test('folderFromIndex rejects bad indexes', () => {
  const list = [{ path: 'C:/projects/a' }]
  assert.equal(folderFromIndex(list, 0), 'C:/projects/a')
  assert.equal(folderFromIndex(list, '0'), 'C:/projects/a')
  for (const bad of [-1, 1, 0.5, NaN, '0; rm', '', undefined]) assert.equal(folderFromIndex(list, bad), null)
})

test('slug makes safe agent names', async () => {
  const { slug } = await import('../src/route.js')
  assert.equal(slug('My Project'), 'my-project')
  assert.equal(slug('a"&b|c'), 'a-b-c')
  assert.equal(slug('x'.repeat(50)).length, 32)
  assert.equal(slug('***'), 'agent')
})

test('groupText: only mentions of / replies to this bot, never commands', async () => {
  const { groupText } = await import('../src/route.js')
  const m = (text, extra = {}) => ({ text, ...extra })
  assert.equal(groupText(m('@agent1_bot run tests'), 'agent1_bot'), 'run tests')
  assert.equal(groupText(m('hello everyone'), 'agent1_bot'), null)
  assert.equal(groupText(m('/list'), 'agent1_bot'), null)
  assert.equal(groupText(m('/list@agent1_bot'), 'agent1_bot'), null)
  assert.equal(groupText(m('yes do it', { reply_to_message: { from: { username: 'agent1_bot' } } }), 'agent1_bot'), 'yes do it')
  assert.equal(groupText(m('ok', { reply_to_message: { from: { username: 'other_bot' } } }), 'agent1_bot'), null)
})

test('cut never splits an emoji', async () => {
  const { cut } = await import('../src/route.js')
  assert.equal(cut('ab😀', 3), 'ab')
  assert.equal(cut('abc', 10), 'abc')
})

test('parseRoots keeps folders that exist and reports the rest', async () => {
  const { parseRoots } = await import('../src/route.js')
  const exists = (p) => p !== 'C:/nope'
  assert.deepEqual(parseRoots(' C:/a , C:/nope,, C:/b ', exists), { roots: ['C:/a', 'C:/b'], missing: ['C:/nope'] })
  assert.deepEqual(parseRoots('', exists), { roots: [], missing: [] })
})
