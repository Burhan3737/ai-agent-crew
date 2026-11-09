import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { projectDir, firstMessage, listConversations } from '../src/history.js'
import { parseHub } from '../src/route.js'

const line = (content, extra = {}) => JSON.stringify({ type: 'user', message: { content }, ...extra })

test('projectDir matches how Claude names folders', () => {
  assert.equal(path.basename(projectDir('C:/projects/my.app_1', 'H')), 'C--projects-my-app-1')
})

test('firstMessage skips system noise and unwraps phone messages', () => {
  assert.equal(firstMessage([line('<system-reminder>x</system-reminder>'), line('fix the login bug')].join('\n')), 'fix the login bug')
  assert.equal(firstMessage(line('<channel source="tg" chat_id="1" from="telegram">\nhello from phone\n</channel>')), 'hello from phone')
  assert.equal(firstMessage(line([{ type: 'text', text: 'array form' }])), 'array form')
  assert.equal(firstMessage('{"type":"mode"}\nnot json\n' + line('still found')), 'still found')
  assert.equal(firstMessage('{"type":"mode"}'), null)
})

test('listConversations: newest first, limited, skips empty and odd files', () => {
  const home = fs.mkdtempSync(path.join((fs.mkdirSync('.agentTempWork', { recursive: true }), '.agentTempWork'), 'hist-'))
  const dir = projectDir('C:/p/a', home)
  fs.mkdirSync(dir, { recursive: true })
  const id = (n) => `${String(n).repeat(8)}-1111-2222-3333-444444444444`
  const write = (name, text, secondsAgo) => {
    fs.writeFileSync(path.join(dir, name), text)
    const t = new Date(Date.now() - secondsAgo * 1000)
    fs.utimesSync(path.join(dir, name), t, t)
  }
  write(`${id(1)}.jsonl`, line('older'), 100)
  write(`${id(2)}.jsonl`, line('newer'), 10)
  write(`${id(3)}.jsonl`, '{"type":"mode"}', 1)          // never used
  write('evil & calc.jsonl', line('bad name'), 1)        // not a conversation id
  const list = listConversations('C:/p/a', { home })
  assert.deepEqual(list.map((c) => c.title), ['newer', 'older'])
  assert.equal(list[0].id, id(2))
  assert.equal(listConversations('C:/p/a', { home, limit: 1 }).length, 1)
  assert.deepEqual(listConversations('C:/missing', { home }), [])
  fs.rmSync(home, { recursive: true })
})

test('/resume is a hub command', () => {
  assert.deepEqual(parseHub('/resume backend'), { cmd: 'resume', args: ['backend'] })
})
