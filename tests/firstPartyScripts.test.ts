/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// First-party packs ship their app scripts as text (src/firstParty, bundled
// into main with ?raw) and nothing compiles them, so a syntax error only
// shows once the app is opened: Worlds didn't open from 1.2.5 to 1.3.1.
// Every one of them must parse.

function scripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return scripts(path)
    return /\.(m?js)$/.test(name) ? [path] : []
  })
}

/** A module's syntax error as V8 (Chromium's engine too) reports it, or null when it parses. */
function syntaxError(source: string): string | null {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' })
  return r.status === 0 ? null : (r.stderr.split('\n').find((l) => l.includes('Error')) ?? r.stderr.trim())
}

describe('first-party pack scripts', () => {
  const files = scripts(join(__dirname, '..', 'src', 'firstParty'))

  it('finds them', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s parses', (file) => {
    expect(syntaxError(readFileSync(file, 'utf8'))).toBeNull()
  })

  it('catches two statements run together, as Worlds once shipped', () => {
    expect(syntaxError("if (a) b()\nelse if (k === 'shift') keys.add(k) else if (c) d()\n")).toMatch(/SyntaxError/)
  })
})
