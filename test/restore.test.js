import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { missingAgents, resumeArgs, setupSummary } from '../src/route.js'
import { autostartScript, enableAutostart, disableAutostart, isAutostartOn } from '../src/autostart.js'

const ID = '14dcfe93-2007-4022-baf4-84a0354a1573'

test('only agents that did not come back are offered', () => {
  const running = { a: { folder: 'A', sessionId: ID }, b: { folder: 'B', sessionId: null } }
  assert.deepEqual(missingAgents(running, (n) => n === 'a'), [{ name: 'b', folder: 'B', sessionId: null }])
  assert.deepEqual(missingAgents({}, () => false), [])
})

test('resumeArgs only ever passes a real conversation id', () => {
  assert.deepEqual(resumeArgs(ID), ['--resume', ID])
  for (const bad of [null, undefined, '', 'abc', ID + ' & calc', '" & calc & "']) assert.deepEqual(resumeArgs(bad), [])
})

test('setup summary shows what is configured and how to change it', () => {
  const text = setupSummary({ hubUsername: 'hub_bot', roots: ['C:/a', 'C:/b'] }, 'Agent Crew', 3, true)
  for (const part of ['already set up', '@hub_bot', 'Agent Crew', '3', 'C:/a, C:/b', 'on', 'crew setup --reset', '/addbot', 'crew folders']) {
    assert.ok(text.includes(part), part)
  }
})

test('autostart script runs node hidden, with both paths quoted', () => {
  assert.equal(
    autostartScript('C:/Program Files/nodejs/node.exe', 'C:/x y/bridge.js'),
    'CreateObject("WScript.Shell").Run """C:/Program Files/nodejs/node.exe"" ""C:/x y/bridge.js""", 0, False\r\n',
  )
})

test('autostart can be turned on and off', () => {
  fs.mkdirSync('.agentTempWork', { recursive: true })
  process.env.CREW_STARTUP = fs.mkdtempSync(path.join('.agentTempWork', 'startup-'))
  assert.equal(isAutostartOn(), false)
  enableAutostart()
  assert.equal(isAutostartOn(), true)
  disableAutostart()
  assert.equal(isAutostartOn(), false)
  disableAutostart() // turning it off twice is fine
  fs.rmSync(process.env.CREW_STARTUP, { recursive: true })
  delete process.env.CREW_STARTUP
})
