/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict'
// node --test native/haptics/test/build-native.test.js
//
// scripts/build-native.mjs argument handling. None of these start a build:
// bad arguments fail before node-gyp runs, and other platforms skip.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const script = path.join(__dirname, '..', '..', '..', 'scripts', 'build-native.mjs')

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    // ELECTRON_RUN_AS_NODE keeps this working when the suite runs inside Electron.
    env: { ...process.env, APEX_NATIVE_ARCH: '', ...env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
  })
  return { code: result.status, out: `${result.stdout}${result.stderr}` }
}

const onMac = process.platform === 'darwin'

test('other platforms skip with a notice', { skip: onMac ? 'this is a Mac' : false }, () => {
  const { code, out } = run(['--arch=bogus'])
  assert.equal(code, 0)
  assert.match(out, /macOS only, skipping/)
})

test('--help prints usage and exits 0', { skip: onMac ? false : 'macOS only' }, () => {
  const { code, out } = run(['--help'])
  assert.equal(code, 0)
  assert.match(out, /usage: node scripts\/build-native\.mjs \[--arch=universal\|host\|arm64\|x64\]/)
})

test('an unknown --arch fails before building', { skip: onMac ? false : 'macOS only' }, () => {
  for (const args of [['--arch=bogus'], ['--arch', 'ia32'], ['--arch='], ['--arch']]) {
    const { code, out } = run(args)
    assert.equal(code, 1, args.join(' '))
    assert.match(out, /--arch must be universal, host, arm64 or x64/)
    assert.doesNotMatch(out, /building for Electron/)
  }
})

test('APEX_NATIVE_ARCH is validated the same way', { skip: onMac ? false : 'macOS only' }, () => {
  const { code, out } = run([], { APEX_NATIVE_ARCH: 'sparc' })
  assert.equal(code, 1)
  assert.match(out, /got sparc/)
})

test('an unknown argument fails before building', { skip: onMac ? false : 'macOS only' }, () => {
  const { code, out } = run(['--frobnicate'])
  assert.equal(code, 1)
  assert.match(out, /unknown argument --frobnicate/)
  assert.doesNotMatch(out, /building for Electron/)
})
