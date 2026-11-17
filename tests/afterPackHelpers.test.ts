/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The packaged helpers carry Apex's name everywhere, CFBundleName included.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { helperName, nameHelpers } from '../scripts/release/afterPack.mjs'

const plist = (name: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>CFBundleName</key>\n\t<string>${name}</string>\n</dict>\n</plist>\n`

describe('afterPack: helper names', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('swaps Electron for the product name and leaves other names alone', () => {
    expect(helperName('Electron Helper', 'Apex')).toBe('Apex Helper')
    expect(helperName('Electron Helper (Renderer)', 'Apex')).toBe('Apex Helper (Renderer)')
    expect(helperName('Apex Helper (GPU)', 'Apex')).toBe('Apex Helper (GPU)')
    expect(helperName('Electron Framework', 'Apex')).toBe('Electron Framework')
  })

  it.runIf(process.platform === 'darwin')('renames every helper bundle once', () => {
    const app = mkdtempSync(join(tmpdir(), 'apex-afterpack-'))
    dirs.push(app)
    const names = ['Electron Helper', 'Electron Helper (GPU)', 'Apex Helper (Plugin)']
    for (const [i, name] of names.entries()) {
      const contents = join(app, 'Contents', 'Frameworks', `Helper ${i}.app`, 'Contents')
      mkdirSync(contents, { recursive: true })
      writeFileSync(join(contents, 'Info.plist'), plist(name))
    }
    expect(nameHelpers(app, 'Apex')).toBe(2)
    expect(nameHelpers(app, 'Apex')).toBe(0)
    const read = (i: number): string =>
      execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', join(app, 'Contents', 'Frameworks', `Helper ${i}.app`, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
    expect([read(0), read(1), read(2)]).toEqual(['Apex Helper', 'Apex Helper (GPU)', 'Apex Helper (Plugin)'])
  })
})
