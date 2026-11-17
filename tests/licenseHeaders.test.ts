/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every first-party source file carries the MPL-2.0 notice (CONTRIBUTING.md › Licence and copyright), except the
// companion art's sources, which carry the Apex Companion Art notice instead (ART-LICENSE.md, section 1). That
// includes the build's own sources: the NSIS script, the gyp file, YAML, property lists and the .NET project, each
// in its own comment syntax. Test fixtures, generated assets and JSON (which has no comments) are data, not source,
// and are left as they are.

const REPO = join(__dirname, '..')
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|css|swift|cs|h|m|mm|c|cc|cpp|py|sh|html|nsh|gyp|yml|yaml|plist|csproj)$/
const NOT_SOURCE = [/^tests\/fixtures\//, /^src\/renderer\/public\//]
/** The art's sources: the asset recipes, and the scripts that draw the mark and render Pip. */
const ART = ['scripts/companion-assets/', 'scripts/app-icons/art.mjs', 'scripts/app-icons/render-pip.mjs', 'scripts/app-icons/pip/']
const isArt = (file: string): boolean => ART.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path))

const mpl = (head: string): boolean => head.includes('This Source Code Form is subject to the terms of the Mozilla Public') && head.includes('mozilla.org/MPL/2.0/')
const art = (head: string): boolean => head.includes('Part of the Apex Companion Art: licensed under the Apex Companion Art License') && head.includes('(ART-LICENSE.md), not under the Mozilla Public License.')

const sources = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((f) => SOURCE.test(f) && !NOT_SOURCE.some((r) => r.test(f)))
const head = (file: string): string => readFileSync(join(REPO, file), 'utf8').slice(0, 600)

describe('licence notices', () => {
  it('every source file starts with the MPL-2.0 notice, except the companion art', () => {
    const files = sources().filter((f) => !isArt(f))
    expect(files.length).toBeGreaterThan(1000)
    expect(files.filter((f) => !mpl(head(f)))).toEqual([])
  })

  it('the companion art’s sources carry the art notice instead, never the MPL one', () => {
    const files = sources().filter(isArt)
    expect(files.length).toBeGreaterThan(20)
    expect(files.filter((f) => !art(head(f)) || mpl(head(f)))).toEqual([])
  })

  it('ART-LICENSE.md names every art path, and each art folder points to it', () => {
    const license = readFileSync(join(REPO, 'ART-LICENSE.md'), 'utf8')
    const scope = license.slice(license.indexOf('## 1.'), license.indexOf('## 2.'))
    for (const path of [...ART, 'src/renderer/public/companion/', 'branding/official/']) expect(scope, path).toContain(`\`${path}\``)
    for (const dir of ['scripts/companion-assets', 'scripts/app-icons', 'scripts/app-icons/pip', 'src/renderer/public/companion', 'branding/official']) {
      const notice = join(REPO, dir, 'LICENSE.md')
      expect(existsSync(notice), dir).toBe(true)
      expect(readFileSync(notice, 'utf8'), dir).toMatch(/Apex Companion Art License/)
    }
  })
})
