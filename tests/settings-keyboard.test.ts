/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The keyboard audit: click handlers on elements that can't take focus.
// It fails for the kit, settings, welcome and first-week files and only
// warns for the rest, so each area can be fixed on its own.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditKeyboard } from '../src/renderer/src/ui/logic/keys'

const ROOT = join(__dirname, '..', 'src', 'renderer', 'src')
const OWN = [/^ui\//, /^settings\//, /^first-week\//, /^pages\/(Settings|Welcome|FirstWeekPage)\.tsx$/, /^overlay\/surfaces\/settings\//]

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? tsxFiles(path) : name.endsWith('.tsx') ? [path] : []
  })
}

describe('keyboard audit', () => {
  it('flags pointer-only handlers and accepts focusable or hidden ones', () => {
    expect(auditKeyboard('<div className="x" onClick={() => go()}>a</div>')).toEqual([{ line: 1, tag: 'div' }])
    expect(auditKeyboard('<div role="button" tabIndex={0} onClick={go} onKeyDown={key}>a</div>')).toEqual([])
    expect(auditKeyboard('<div className="scrim" aria-hidden onClick={close} />')).toEqual([])
    expect(auditKeyboard('<button onClick={go}>a</button>')).toEqual([])
    expect(auditKeyboard('<li role="option" aria-selected={a} onClick={pick}>x</li>')).toEqual([])
    expect(auditKeyboard('\n\n<span onClick={(e) => e.stopPropagation()}>x</span>')).toEqual([{ line: 3, tag: 'span' }])
  })

  it('finds nothing in the kit, settings, welcome and first-week files, and lists the rest', () => {
    const own: string[] = []
    const others: string[] = []
    for (const file of tsxFiles(ROOT)) {
      const rel = relative(ROOT, file).split('\\').join('/')
      for (const f of auditKeyboard(readFileSync(file, 'utf8'))) (OWN.some((r) => r.test(rel)) ? own : others).push(`${rel}:${f.line} <${f.tag}>`)
    }
    if (others.length) console.warn(`Keyboard audit: ${others.length} pointer-only handlers in other files:\n  ${others.slice(0, 40).join('\n  ')}`)
    expect(own).toEqual([])
  })
})
