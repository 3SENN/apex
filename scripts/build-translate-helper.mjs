/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds native/translate/build/apex-translate, Apex's on-device page
// translation helper (TR-05), a universal macOS binary, with Apple's swiftc.
// electron-builder copies it into the app's Resources next to apex-speech
// (mac.extraResources). On other platforms there is nothing to build.
//   APEX_TRANSLATE_ARCHS=arm64 node scripts/build-translate-helper.mjs   one slice, for a quick check
// APEX_TRANSLATE_SIGN_IDENTITY signs with a real identity and the hardened
// runtime (the release build does this); without it the binary is signed ad hoc.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { helperInfoPlist } from './release/bundle.mjs'

if (process.platform !== 'darwin') {
  console.log('apex-translate: macOS only, skipping.')
  process.exit(0)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'translate')
const out = join(root, 'build')
// The bundle id is <APEX_BUNDLE_ID>.translate (com.sennechin.apex.translate by default; scripts/release/bundle.mjs).
const infoPlist = helperInfoPlist(join(root, 'Info.plist'), join(out, 'plist'), 'translate')
mkdirSync(out, { recursive: true })

const sources = readdirSync(root)
  .filter((name) => name.endsWith('.swift'))
  .sort()
  .map((name) => join(root, name))
if (!sources.some((file) => file.endsWith('/main.swift'))) throw new Error('apex-translate: main.swift is missing.')

const archs = (process.env.APEX_TRANSLATE_ARCHS ?? 'arm64,x86_64').split(',').map((a) => a.trim()).filter(Boolean)
const slices = archs.map((arch) => {
  const target = join(out, `apex-translate-${arch}`)
  execFileSync(
    'xcrun',
    [
      'swiftc', '-O', '-swift-version', '5',
      // macOS 13 is the floor; translation itself is chosen at run time (macOS 26), detection works everywhere.
      '-target', `${arch}-apple-macos13.0`,
      // Translation.framework is missing before macOS 14.4: weak, so the helper still starts and says "unavailable".
      '-Xlinker', '-weak_framework', '-Xlinker', 'Translation',
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', infoPlist,
      ...sources,
      '-o', target,
    ],
    { stdio: 'inherit' },
  )
  return target
})

const universal = join(out, 'apex-translate')
if (slices.length === 1) {
  renameSync(slices[0], universal)
} else {
  execFileSync('lipo', ['-create', ...slices, '-output', universal], { stdio: 'inherit' })
  for (const slice of slices) rmSync(slice)
}
const identity = process.env.APEX_TRANSLATE_SIGN_IDENTITY
execFileSync('codesign', identity ? ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, universal] : ['--force', '--sign', '-', universal], { stdio: 'inherit' })
console.log(`apex-translate: built ${universal} (${archs.join(', ')}) from ${sources.length} files`)
