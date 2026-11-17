/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict'
// node --test native/haptics/test/loader.test.js
//
// The loader's stub behaviour, with injected platform, file checks and
// dlopen, so it runs anywhere. When build/atelier_haptics.node exists on a Mac,
// it also loads the real addon and checks its argument handling. Playing a
// real pattern needs ATELIER_HAPTICS_LIVE=1.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const haptics = require('..')
const { PATTERNS, BINARY, normalisePattern, defaultPaths, createStub, loadHaptics } = haptics

const VALID = ['alignment', 'levelChange', 'level-change', 'generic']
const INVALID = [
  '',
  'Alignment',
  'level_change',
  'levelchange',
  'tick',
  ' alignment',
  'alignment\0',
  'constructor',
  '__proto__',
  'toString',
  'x'.repeat(10_000),
  42,
  null,
  undefined,
  true,
  {},
  [],
  ['alignment'],
  Symbol('alignment'),
  () => 'alignment',
  Object.create(null),
]

const FAKE_FILE = '/fake/atelier_haptics.node'
const exists = (file) => file === FAKE_FILE

function fakeAddon() {
  const calls = []
  return {
    calls,
    dlopen(mod, file) {
      calls.push(['dlopen', file])
      mod.exports = {
        perform(name) {
          calls.push(['perform', name])
          return true
        },
      }
    },
  }
}

function noDlopen() {
  throw new Error('dlopen must not be called')
}

test('PATTERNS lists the three AppKit patterns and is frozen', () => {
  assert.deepEqual([...PATTERNS], ['alignment', 'levelChange', 'generic'])
  assert.ok(Object.isFrozen(PATTERNS))
  assert.equal(BINARY, 'atelier_haptics.node')
})

test('normalisePattern maps the kebab-case spelling and keeps the rest', () => {
  assert.equal(normalisePattern('alignment'), 'alignment')
  assert.equal(normalisePattern('levelChange'), 'levelChange')
  assert.equal(normalisePattern('level-change'), 'levelChange')
  assert.equal(normalisePattern('generic'), 'generic')
})

test('normalisePattern throws a TypeError for anything else', () => {
  for (const value of INVALID) {
    assert.throws(() => normalisePattern(value), TypeError, `accepted ${String(typeof value)}`)
  }
})

test('the TypeError message is short even for a huge string', () => {
  try {
    normalisePattern('y'.repeat(100_000))
    assert.fail('should throw')
  } catch (err) {
    assert.ok(err instanceof TypeError)
    assert.ok(err.message.length < 120, err.message)
  }
})

for (const platform of ['linux', 'win32', 'freebsd']) {
  test(`${platform} gets the stub without touching the disk`, () => {
    const h = loadHaptics({
      platform,
      exists: () => assert.fail('exists must not be called'),
      dlopen: noDlopen,
    })
    assert.equal(h.available, false)
    assert.equal(h.reason, 'unsupported-platform')
    assert.equal(h.path, null)
    assert.equal(h.error, undefined)
    for (const p of VALID) assert.equal(h.perform(p), false)
  })
}

test('a missing binary on macOS gives the stub and never calls dlopen', () => {
  const h = loadHaptics({
    platform: 'darwin',
    paths: ['/nowhere/a.node', '/nowhere/b.node'],
    exists: () => false,
    dlopen: noDlopen,
  })
  assert.equal(h.available, false)
  assert.equal(h.reason, 'missing')
  for (const p of VALID) assert.equal(h.perform(p), false)
})

test('a real missing path on disk gives the stub', () => {
  const h = loadHaptics({
    platform: 'darwin',
    paths: [path.join(__dirname, 'no-such-dir', BINARY)],
  })
  assert.equal(h.reason, 'missing')
  assert.equal(h.perform('generic'), false)
})

test('an empty path list gives the stub', () => {
  const h = loadHaptics({ platform: 'darwin', paths: [], dlopen: noDlopen })
  assert.equal(h.reason, 'missing')
})

test('an exists check that throws counts as missing', () => {
  const h = loadHaptics({
    platform: 'darwin',
    paths: [FAKE_FILE],
    exists: () => {
      throw new Error('EACCES')
    },
    dlopen: noDlopen,
  })
  assert.equal(h.reason, 'missing')
})

test('a binary that fails to load gives the stub with the error', () => {
  const h = loadHaptics({
    platform: 'darwin',
    paths: [FAKE_FILE],
    exists,
    dlopen: () => {
      throw new Error("incompatible architecture (have 'x86_64', need 'arm64')")
    },
  })
  assert.equal(h.available, false)
  assert.equal(h.reason, 'load-failed')
  assert.match(h.error, /incompatible architecture/)
  for (const p of VALID) assert.equal(h.perform(p), false)
})

test('a non-Error thrown by dlopen is still reported', () => {
  const h = loadHaptics({
    platform: 'darwin',
    paths: [FAKE_FILE],
    exists,
    dlopen: () => {
      throw 'boom'
    },
  })
  assert.equal(h.reason, 'load-failed')
  assert.equal(h.error, 'boom')
})

test('a binary without perform gives the invalid-addon stub', () => {
  for (const exportsValue of [{}, { perform: 'nope' }, null, 7]) {
    const h = loadHaptics({
      platform: 'darwin',
      paths: [FAKE_FILE],
      exists,
      dlopen: (mod) => {
        mod.exports = exportsValue
      },
    })
    assert.equal(h.available, false)
    assert.equal(h.reason, 'invalid-addon')
    assert.match(h.error, /no perform function/)
    assert.equal(h.perform('alignment'), false)
  }
})

test('every stub rejects unknown patterns with a TypeError', () => {
  const stubs = [
    loadHaptics({ platform: 'linux' }),
    loadHaptics({ platform: 'darwin', paths: [], dlopen: noDlopen }),
    createStub('load-failed', 'x'),
  ]
  for (const stub of stubs) {
    for (const value of INVALID) assert.throws(() => stub.perform(value), TypeError)
  }
})

test('stubs are frozen', () => {
  const stub = createStub('missing')
  assert.ok(Object.isFrozen(stub))
  assert.throws(() => {
    'use strict'
    stub.perform = () => true
  }, TypeError)
  assert.equal(stub.perform('generic'), false)
})

test('createStub only carries an error when given one', () => {
  assert.equal('error' in createStub('missing'), false)
  assert.equal(createStub('load-failed', 'why').error, 'why')
})

test('the first existing path wins', () => {
  const fake = fakeAddon()
  const h = loadHaptics({
    platform: 'darwin',
    paths: ['/nowhere/first.node', FAKE_FILE, '/fake/second.node'],
    exists: (file) => file === FAKE_FILE || file === '/fake/second.node',
    dlopen: fake.dlopen,
  })
  assert.equal(h.available, true)
  assert.equal(h.reason, 'loaded')
  assert.equal(h.path, FAKE_FILE)
  assert.deepEqual(fake.calls, [['dlopen', FAKE_FILE]])
})

test('a loaded addon gets canonical names only, and invalid input never reaches it', () => {
  const fake = fakeAddon()
  const h = loadHaptics({ platform: 'darwin', paths: [FAKE_FILE], exists, dlopen: fake.dlopen })
  for (const p of VALID) assert.equal(h.perform(p), true)
  for (const value of INVALID) assert.throws(() => h.perform(value), TypeError)
  assert.deepEqual(fake.calls.slice(1), [
    ['perform', 'alignment'],
    ['perform', 'levelChange'],
    ['perform', 'levelChange'],
    ['perform', 'generic'],
  ])
  assert.ok(Object.isFrozen(h))
})

test('a native perform that throws or returns non-true reports false', () => {
  for (const nativePerform of [
    () => {
      throw new Error('AppKit said no')
    },
    () => undefined,
    () => 1,
  ]) {
    const h = loadHaptics({
      platform: 'darwin',
      paths: [FAKE_FILE],
      exists,
      dlopen: (mod) => {
        mod.exports = { perform: nativePerform }
      },
    })
    assert.equal(h.available, true)
    assert.equal(h.perform('alignment'), false)
  }
})

test('defaultPaths ends with this folder build output', () => {
  const paths = defaultPaths()
  assert.equal(paths.at(-1), path.join(__dirname, '..', 'build', BINARY))
})

test('defaultPaths tries the packaged Resources/native copy first', () => {
  const resources = '/Applications/Atelier.app/Contents/Resources'
  assert.deepEqual(defaultPaths(resources), [
    path.join(resources, 'native', BINARY),
    path.join(__dirname, '..', 'build', BINARY),
  ])
})

test('defaultPaths without a resources folder is just the build output', () => {
  for (const none of ['', null]) {
    assert.deepEqual(defaultPaths(none), [path.join(__dirname, '..', 'build', BINARY)])
  }
})

test('defaultPaths follows process.resourcesPath, which only Electron sets', () => {
  const resources = process.resourcesPath
  const expected = [path.join(__dirname, '..', 'build', BINARY)]
  if (typeof resources === 'string' && resources) {
    expected.unshift(path.join(resources, 'native', BINARY))
  }
  assert.deepEqual(defaultPaths(), expected)
})

test('the shared perform rejects unknown patterns', () => {
  assert.throws(() => haptics.perform('nope'), TypeError)
  assert.equal(haptics.getHaptics(), haptics.getHaptics())
})

const built = path.join(__dirname, '..', 'build', BINARY)

// The real-addon checks need a build with this Mac's architecture in it
// (build-native.mjs --arch=x64 on Apple silicon makes one without).
function realAddonSkip() {
  if (process.platform !== 'darwin') return 'the addon is macOS only'
  if (!fs.existsSync(built)) return 'build/atelier_haptics.node is not built'
  const want = { arm64: 'arm64', x64: 'x86_64' }[process.arch]
  try {
    const archs = execFileSync('lipo', ['-archs', built], { encoding: 'utf8' }).trim().split(/\s+/)
    if (!archs.includes(want)) return `build/atelier_haptics.node has no ${want} slice (${archs.join(', ')})`
  } catch {
    return 'lipo could not read build/atelier_haptics.node'
  }
  return false
}
const skipReal = realAddonSkip()
const canLoadReal = skipReal === false

test(
  'the built addon loads through the loader',
  { skip: skipReal },
  () => {
    const h = loadHaptics({ paths: [built] })
    assert.equal(h.reason, 'loaded', h.error)
    assert.equal(h.available, true)
    assert.equal(h.path, built)
    for (const value of INVALID) assert.throws(() => h.perform(value), TypeError)
  },
)

test(
  'the built addon validates its own arguments',
  { skip: skipReal },
  () => {
    const mod = { exports: {} }
    process.dlopen(mod, built)
    const addon = mod.exports
    assert.deepEqual(Object.keys(addon), ['perform'])
    for (const value of [undefined, 42, null, {}, '', 'Alignment', 'alignment\0', 'x'.repeat(10_000)]) {
      assert.throws(() => addon.perform(value), TypeError)
    }
    assert.throws(() => addon.perform(), TypeError)
  },
)

test(
  'the built addon plays every pattern (ATELIER_HAPTICS_LIVE=1)',
  {
    skip: !canLoadReal
      ? skipReal
      : process.env.ATELIER_HAPTICS_LIVE !== '1'
        ? 'set ATELIER_HAPTICS_LIVE=1 to play real patterns on the trackpad'
        : false,
  },
  () => {
    const h = loadHaptics({ paths: [built] })
    for (const p of VALID) assert.equal(h.perform(p), true)
    const mod = { exports: {} }
    process.dlopen(mod, built)
    for (const p of VALID) assert.equal(mod.exports.perform(p), true)
  },
)
