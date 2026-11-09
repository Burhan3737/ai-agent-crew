import test from 'node:test'
import assert from 'node:assert/strict'
import { trustKeys } from '../src/route.js'

const DOWN = '\x1b[B'
const ENTER = '\r'

test('no trust prompt on screen means no keys', () => {
  assert.equal(trustKeys('Iamusingthisforlocaldevelopment'), null)
})

test('waits until the prompt is fully drawn', () => {
  assert.equal(trustKeys('Quicksafetycheck❯No,exitYes,Itrustthisfolder'), null)
})

test('moves down to Yes when No is selected', () => {
  assert.deepEqual(trustKeys('❯No,exitYes,ItrustthisfolderEntertoconfirm'), [DOWN, ENTER])
})

test('just confirms when Yes is already selected', () => {
  assert.deepEqual(trustKeys('❯1.Yes,Itrustthisfolder2.No,exitEntertoconfirm'), [ENTER])
})

test('unknown selection presses nothing', () => {
  assert.equal(trustKeys('Yes,Itrustthisfolder No,exit Entertoconfirm'), null)
})
