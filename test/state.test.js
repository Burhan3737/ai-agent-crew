import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { STATE_DIR } from '../src/state.js'

test('settings live in the home folder unless overridden', { skip: process.env.CREW_STATE }, () => {
  assert.equal(STATE_DIR, path.join(os.homedir(), '.crew'))
})

test('package declares the crew command and it can be run by npm', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  assert.equal(pkg.bin.crew, 'src/crew.js')
  assert.ok(fs.readFileSync('src/crew.js', 'utf8').startsWith('#!/usr/bin/env node'))
})
