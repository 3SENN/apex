/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { pluralCases } from '@shared/i18n/core'
import { EN, EN_FRAGMENTS } from '@shared/i18n/en'
import { SWEEP_COMPLETE } from '@shared/i18n/locales'
import { NL, NL_FRAGMENTS } from '@shared/i18n/nl'

// Dutch against English. A Dutch key English lacks, a placeholder that
// differs, or a broken plural fails now; a key Dutch hasn't translated yet
// only warns until SWEEP_COMPLETE is set.

/** Placeholder names in a message, plural variables included, sorted and unique. */
function placeholders(message: string): string[] {
  const names = new Set<string>()
  const walk = (text: string): void => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) return
      let depth = 0
      let end = -1
      for (let j = open; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}' && --depth === 0) {
          end = j
          break
        }
      }
      if (end < 0) return
      const inner = text.slice(open + 1, end)
      const plural = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner)
      if (plural) {
        names.add(plural[1] ?? '')
        for (const body of pluralCases(plural[2] ?? '').values()) walk(body)
      } else if (/^\s*[A-Za-z0-9_]+\s*$/.test(inner)) names.add(inner.trim())
      i = end + 1
    }
  }
  walk(message)
  return [...names].sort()
}

/** Problems with the plural blocks of a message for a locale; empty when fine. */
function pluralProblems(message: string, locale: string): string[] {
  const allowed = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[])
  const problems: string[] = []
  const re = /\{\s*[A-Za-z0-9_]+\s*,\s*plural\s*,/g
  for (let m = re.exec(message); m; m = re.exec(message)) {
    let depth = 0
    let end = -1
    for (let j = m.index; j < message.length; j++) {
      if (message[j] === '{') depth++
      else if (message[j] === '}' && --depth === 0) {
        end = j
        break
      }
    }
    if (end < 0) {
      problems.push('unclosed plural')
      continue
    }
    const cases = pluralCases(message.slice(m.index + m[0].length, end))
    if (!cases.has('other')) problems.push('no other case')
    for (const name of cases.keys()) if (!/^=\d+$/.test(name) && !allowed.has(name)) problems.push(`case “${name}” is not a ${locale} plural category`)
  }
  return problems
}

const enKeys = new Set(Object.keys(EN))

describe('Dutch parity', () => {
  it('has a fragment for each English area and no others', () => {
    const extra = Object.keys(NL_FRAGMENTS).filter((area) => !(area in EN_FRAGMENTS))
    const missing = Object.keys(EN_FRAGMENTS).filter((area) => !(area in NL_FRAGMENTS))
    expect(extra).toEqual([])
    if (SWEEP_COMPLETE) expect(missing).toEqual([])
    else if (missing.length > 0) console.warn(`i18n: no Dutch fragment yet for ${missing.join(', ')}.`)
  })

  it('defines only keys English has, in their own area', () => {
    for (const [area, fragment] of Object.entries(NL_FRAGMENTS)) {
      for (const key of Object.keys(fragment)) {
        expect(enKeys.has(key), `${key} is not an English key`).toBe(true)
        expect(key.split('.')[0], key).toBe(area)
      }
    }
  })

  it('covers every key once SWEEP_COMPLETE is set', () => {
    const missing = [...enKeys].filter((key) => !(key in NL))
    if (SWEEP_COMPLETE) expect(missing).toEqual([])
    else if (missing.length > 0) console.warn(`i18n: Dutch has ${enKeys.size - missing.length} of ${enKeys.size} keys.`)
  })

  it('keeps every placeholder of the English', () => {
    const mismatched: string[] = []
    for (const [key, dutch] of Object.entries(NL)) {
      const english = (EN as Record<string, string>)[key]
      if (english === undefined || dutch === undefined) continue
      // {brand} is the i18n layer's own (the app's name), so either language may use it where it reads best.
      const passed = (m: string): string => placeholders(m).filter((p) => p !== 'brand').join()
      if (passed(english) !== passed(dutch)) mismatched.push(`${key}: ${passed(english)} vs ${passed(dutch)}`)
    }
    expect(mismatched).toEqual([])
  })

  it('writes valid plural forms in both languages', () => {
    const problems: string[] = []
    for (const [key, text] of Object.entries(EN)) for (const p of pluralProblems(text, 'en')) problems.push(`en ${key}: ${p}`)
    for (const [key, text] of Object.entries(NL)) if (text) for (const p of pluralProblems(text, 'nl')) problems.push(`nl ${key}: ${p}`)
    expect(problems).toEqual([])
  })

  it('has no empty Dutch strings where English has text', () => {
    const empty = Object.entries(NL).filter(([key, text]) => text === '' && (EN as Record<string, string>)[key] !== '')
    expect(empty).toEqual([])
  })

  it('the helpers see what they should', () => {
    expect(placeholders('{count, plural, one {# in {group}} other {# in {group}}} for {name}')).toEqual(['count', 'group', 'name'])
    expect(pluralProblems('{n, plural, one {#} few {#}}', 'nl')).toEqual(['no other case', 'case “few” is not a nl plural category'])
    expect(pluralProblems('{n, plural, =0 {none} one {#} other {#}}', 'en')).toEqual([])
  })
})
