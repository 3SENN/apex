/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds native/speech/build/atelier-speech, a universal macOS binary, with
// Apple's swiftc: every .swift file in native/speech (main.swift holds the
// entry point; Lid.swift and any other observer join automatically).
// On other platforms there is nothing to build.
//   ATELIER_SPEECH_ARCHS=arm64 node scripts/build-speech-helper.mjs   one slice, for a quick check
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { helperInfoPlist } from './release/bundle.mjs'

// Atelier-speech.exe with dotnet publish; native/speech-win/README.md
if (process.platform === 'win32') {
  const { buildWindowsHelper } = await import('../native/speech-win/build.mjs')
  buildWindowsHelper(process.argv.slice(2))
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log('atelier-speech: macOS only, skipping.')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'speech')
const out = join(root, 'build')
// The bundle id is <ATELIER_BUNDLE_ID>.speech (com.sennechin.atelier.speech by default; scripts/release/bundle.mjs).
const infoPlist = helperInfoPlist(join(root, 'Info.plist'), join(out, 'plist'), 'speech')
mkdirSync(out, { recursive: true })

const sources = readdirSync(root)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => join(root, name))
if (!sources.some((file) => file.endsWith('/main.swift'))) throw new Error('atelier-speech: main.swift is missing.')

const archs = (process.env.ATELIER_SPEECH_ARCHS ?? 'arm64,x86_64').split(',').map((a) => a.trim()).filter(Boolean)
const slices = archs.map((arch) => {
  const target = join(out, `atelier-speech-${arch}`)
  execFileSync(
    'xcrun',
    [
      'swiftc', '-O', '-swift-version', '5',
      '-target', `${arch}-apple-macos13.0`,
      // An embedded Info.plist carries the usage descriptions macOS shows.
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', infoPlist,
      ...sources,
      '-o', target,
    ],
    { stdio: 'inherit' },
  )
  return target
})

const universal = join(out, 'atelier-speech')
if (slices.length === 1) {
  renameSync(slices[0], universal)
} else {
  execFileSync('lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' })
  for (const slice of slices) rmSync(slice)
}
execFileSync('codesign', ['--force', '--sign', '-', universal], { stdio: 'inherit' })
console.log(`atelier-speech: built ${universal} (${archs.join(', ')}) from ${sources.length} files`)
