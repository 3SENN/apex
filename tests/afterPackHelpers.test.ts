/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The packaged helpers carry Atelier's name everywhere, CFBundleName included.

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
    expect(helperName('Electron Helper', 'Atelier')).toBe('Atelier Helper')
    expect(helperName('Electron Helper (Renderer)', 'Atelier')).toBe('Atelier Helper (Renderer)')
    expect(helperName('Atelier Helper (GPU)', 'Atelier')).toBe('Atelier Helper (GPU)')
    expect(helperName('Electron Framework', 'Atelier')).toBe('Electron Framework')
  })

  it.runIf(process.platform === 'darwin')('renames every helper bundle once', () => {
    const app = mkdtempSync(join(tmpdir(), 'atelier-afterpack-'))
    dirs.push(app)
    const names = ['Electron Helper', 'Electron Helper (GPU)', 'Atelier Helper (Plugin)']
    for (const [i, name] of names.entries()) {
      const contents = join(app, 'Contents', 'Frameworks', `Helper ${i}.app`, 'Contents')
      mkdirSync(contents, { recursive: true })
      writeFileSync(join(contents, 'Info.plist'), plist(name))
    }
    expect(nameHelpers(app, 'Atelier')).toBe(2)
    expect(nameHelpers(app, 'Atelier')).toBe(0)
    const read = (i: number): string =>
      execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', '-o', '-', join(app, 'Contents', 'Frameworks', `Helper ${i}.app`, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
    expect([read(0), read(1), read(2)]).toEqual(['Atelier Helper', 'Atelier Helper (GPU)', 'Atelier Helper (Plugin)'])
  })
})
