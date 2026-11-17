/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds native/calendar/build/apex-calendar, Apex's read-only Calendar and
// Reminders helper, a universal macOS binary, with Apple's
// swiftc. electron-builder copies it into the app's Resources next to
// apex-speech (mac.extraResources). On other platforms there is nothing to build.
//   APEX_CALENDAR_ARCHS=arm64 node scripts/build-calendar-helper.mjs   one slice, for a quick check
// APEX_CALENDAR_SIGN_IDENTITY signs with a real identity and the hardened
// runtime (the release build does this); without it the binary is signed ad hoc.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { helperInfoPlist } from './release/bundle.mjs'

if (process.platform !== 'darwin') {
  console.log('apex-calendar: macOS only, skipping.')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'calendar')
const out = join(root, 'build')
// The bundle id is <APEX_BUNDLE_ID>.calendar (com.sennechin.apex.calendar by default; scripts/release/bundle.mjs).
const infoPlist = helperInfoPlist(join(root, 'Info.plist'), join(out, 'plist'), 'calendar')
mkdirSync(out, { recursive: true })

const sources = readdirSync(root)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => join(root, name))
if (!sources.some((file) => file.endsWith('/main.swift'))) throw new Error('apex-calendar: main.swift is missing.')

const archs = (process.env.APEX_CALENDAR_ARCHS ?? 'arm64,x86_64').split(',').map((a) => a.trim()).filter(Boolean)
const slices = archs.map((arch) => {
  const target = join(out, `apex-calendar-${arch}`)
  execFileSync(
    'xcrun',
    [
      'swiftc', '-O', '-swift-version', '5',
      // macOS 13 is the floor; the macOS 14 full-access requests are chosen at run time.
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

const universal = join(out, 'apex-calendar')
if (slices.length === 1) {
  renameSync(slices[0], universal)
} else {
  execFileSync('lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' })
  for (const slice of slices) rmSync(slice)
}
const identity = process.env.APEX_CALENDAR_SIGN_IDENTITY
execFileSync('codesign', identity ? ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, universal] : ['--force', '--sign', '-', universal], { stdio: 'inherit' })
console.log(`apex-calendar: built ${universal} (${archs.join(', ')}) from ${sources.length} files`)
