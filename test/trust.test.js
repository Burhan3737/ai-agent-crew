import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTrustKey } from '../src/route.js'

const DOWN = '\x1b[B'
const ENTER = '\r'

test('no trust prompt on screen means no key', () => {
  assert.equal(nextTrustKey('Iamusingthisforlocaldevelopment'), null)
})

test('waits until the prompt is fully drawn', () => {
  assert.equal(nextTrustKey('Quicksafetycheck❯No,exitYes,Itrustthisfolder'), null)
})

test('moves down when No is selected', () => {
  assert.equal(nextTrustKey('❯No,exitYes,ItrustthisfolderEntertoconfirm'), DOWN)
})

test('confirms only when Yes is selected', () => {
  assert.equal(nextTrustKey('❯1.Yes,Itrustthisfolder2.No,exitEntertoconfirm'), ENTER)
})

test('goes by the latest drawing of the screen', () => {
  const first = '❯No,exitYes,ItrustthisfolderEntertoconfirm'
  assert.equal(nextTrustKey(first + 'No,exit❯Yes,Itrustthisfolder'), ENTER)
  assert.equal(nextTrustKey(first + 'No,exit❯Yes,Itrustthisfolder❯No,exitYes,Itrustthisfolder'), DOWN) // the prompt reset itself
})

test('unknown selection presses nothing', () => {
  assert.equal(nextTrustKey('Yes,Itrustthisfolder No,exit Entertoconfirm'), null)
})
