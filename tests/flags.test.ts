/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { format } from '@shared/i18n/core'

const relaunch = vi.fn()
const exit = vi.fn()
vi.mock('electron', () => ({ app: { relaunch: () => relaunch(), exit: (code: number) => exit(code), getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))

import { FLAG_DEFS, applyFlag, flagStates, flagValue, isFlagLocked, isFlagOn } from '../src/shared/flags'
import { createFlags } from '../src/main/flags'
import { EN } from '../src/shared/i18n/en'
import { NL } from '../src/shared/i18n/nl'

// ST-57: the apex://flags registry, dependency locking
// and the restart banner.

describe('the catalogue', () => {
  it('has unique ids, valid defaults and known parents', () => {
    const ids = FLAG_DEFS.map((f) => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const f of FLAG_DEFS) {
      expect(f.values).toContain(f.default)
      expect(f.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(f.title.length).toBeGreaterThan(0)
      if (f.parent) expect(ids).toContain(f.parent)
    }
  })

  it('names translated flags in English and Dutch, the English matching the catalogue text', () => {
    const translated = FLAG_DEFS.filter((f) => f.titleKey || f.descriptionKey)
    expect(translated.map((f) => f.id)).toContain('google-signin-firefox')
    for (const f of translated) {
      // The catalogue says {brand} where the definition has the app's name.
      expect(format(EN[f.titleKey!]!), f.id).toBe(f.title)
      expect(format(EN[f.descriptionKey!]!), f.id).toBe(f.description)
      expect(NL[f.titleKey!], f.id).toBeTruthy()
      expect(NL[f.descriptionKey!], f.id).toBeTruthy()
    }
  })

  it("keeps Google's Firefox sign-in identity off unless chosen, with no restart", () => {
    const f = FLAG_DEFS.find((d) => d.id === 'google-signin-firefox')!
    expect([f.default, f.requiresRestart, isFlagOn({}, f.id), isFlagOn({ [f.id]: 'on' }, f.id)]).toEqual(['off', false, false, true])
  })

  it('carries the flags other features read', () => {
    for (const id of ['tables', 'timeline', 'delegation', 'activity-screenshots', 'details-panel-auto-open', 'pseudo-locale', 'apps']) expect(FLAG_DEFS.some((f) => f.id === id), id).toBe(true)
  })
})

describe('values and locking', () => {
  it('uses the default until a value is stored, and ignores values the flag no longer offers', () => {
    expect(flagValue({}, 'pseudo-locale')).toBe('off')
    expect(flagValue({ 'pseudo-locale': 'on' }, 'pseudo-locale')).toBe('on')
    expect(flagValue({ 'pseudo-locale': 'maybe' }, 'pseudo-locale')).toBe('off')
    expect(isFlagOn({}, 'no-such-flag')).toBe(false)
  })

  it('turns a child off and locks it while its parent is off', () => {
    expect(isFlagOn({}, 'tables-agent-writes')).toBe(true)
    const off = { tables: 'off' }
    expect(isFlagOn(off, 'tables-agent-writes')).toBe(false)
    expect(isFlagLocked(off, 'tables-agent-writes')).toBe(true)
    const child = flagStates(off).find((f) => f.id === 'tables-agent-writes')!
    expect(child).toMatchObject({ value: 'off', locked: true })
    expect(() => applyFlag(off, 'tables-agent-writes', 'on')).toThrow(/turned on first/)
  })

  it('keeps a child’s own choice for when the parent comes back', () => {
    let values = applyFlag({}, 'tables-agent-writes', 'off')
    values = applyFlag(values, 'tables', 'off')
    values = applyFlag(values, 'tables', 'on')
    expect(isFlagOn(values, 'tables-agent-writes')).toBe(false)
  })

  it('stores only values that differ from the default, and refuses unknown ones', () => {
    expect(applyFlag({}, 'pseudo-locale', 'on')).toEqual({ 'pseudo-locale': 'on' })
    expect(applyFlag({ 'pseudo-locale': 'on' }, 'pseudo-locale', 'off')).toEqual({})
    expect(() => applyFlag({}, 'nope', 'on')).toThrow(/no experiment/)
    expect(() => applyFlag({}, 'pseudo-locale', 'loud')).toThrow(/can't be set/)
  })

  it('lists newest first', () => {
    const dates = flagStates({}).map((f) => f.addedAt)
    expect([...dates].sort().reverse()).toEqual(dates)
  })
})

describe('the flags service', () => {
  const fakeSettings = () => {
    let flags: Record<string, string> = {}
    return { get: () => ({ flags }), update: (patch: { flags: Record<string, string> }) => (flags = patch.flags) }
  }

  it('saves, broadcasts and marks restart-needed changes against the launch values', () => {
    const settings = fakeSettings()
    const events: unknown[] = []
    const flags = createFlags({ settings, broadcast: (e) => events.push(e) })
    const watch = FLAG_DEFS.find((f) => f.requiresRestart)!
    const other = watch.values.find((v) => v !== watch.default)!
    const after = flags.set(watch.id, other)
    expect(after.find((f) => f.id === watch.id)).toMatchObject({ value: other, pendingRestart: true })
    expect(events.at(-1)).toEqual({ type: 'flags', values: { [watch.id]: other } })
    // Back to the launch value: nothing waits for a restart.
    expect(flags.set(watch.id, watch.default).find((f) => f.id === watch.id)?.pendingRestart).toBe(false)
    expect(flags.isOn('tables')).toBe(true)
  })

  it('relaunches and exits, or uses the smoke stand-in', () => {
    createFlags({ settings: fakeSettings(), broadcast: () => undefined }).relaunch()
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    const instead = vi.fn()
    createFlags({ settings: fakeSettings(), broadcast: () => undefined, relaunch: instead }).relaunch()
    expect(instead).toHaveBeenCalled()
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})
