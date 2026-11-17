/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { brandingAlias, brandingDefines, brandingId, brandingProblems, loadBranding, officialBranding, readBranding, REPO, runtimeBranding } from '../scripts/branding.mjs'
import { bundleIdFrom, helperInfoPlist } from '../scripts/release/bundle.mjs'
import { presetSchema } from '../src/main/companion'
import { BRANDING, brandingFrom, offeredPresets, presetOffered } from '../src/shared/branding'
import { localizedPreset } from '../src/shared/brandingPreset'
import { DEFAULT_LOOK, DEFAULT_PROFILE, PLAIN_LOOK, type CompanionPreset, type CompatibilityConfig } from '../src/shared/companion'
import { normalizeLook } from '../src/shared/companionLogic'
import { EN } from '../src/shared/i18n/en'
import { NL } from '../src/shared/i18n/nl'
import { SETUP_NAMES } from '../src/shared/onboarding'
import { WHATS_NEW } from '../src/shared/whatsNew'

// scripts/branding.mjs: official Apex or the unofficial Summit, as Firefox's
// --enable-official-branding (TRADEMARKS.md). APEX_OFFICIAL_BRANDING decides;
// unset, the private internal/ folder does.

/** Apex's six characters (TRADEMARKS.md), which only the official branding offers. */
const CHARACTERS = ['Pip', 'Juniper', 'Bolt', 'Mochi', 'Sage', 'Pepper']
const CHARACTER_NAME = new RegExp(`\\b(${CHARACTERS.join('|')})\\b`, 'i')

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repo with both brandings and the presets, with or without the internal folder. */
function repo(withInternal: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'apex-branding-'))
  made.push(dir)
  for (const id of ['official', 'unofficial']) {
    mkdirSync(join(dir, 'branding', id), { recursive: true })
    for (const file of ['branding.json', 'companion.json']) {
      if (existsSync(join(REPO, 'branding', id, file))) cpSync(join(REPO, 'branding', id, file), join(dir, 'branding', id, file))
    }
  }
  mkdirSync(join(dir, 'src/renderer/public/companion/config'), { recursive: true })
  cpSync(join(REPO, 'src/renderer/public/companion/config/presets.json'), join(dir, 'src/renderer/public/companion/config/presets.json'))
  if (withInternal) {
    mkdirSync(join(dir, 'internal'), { recursive: true })
    writeFileSync(join(dir, 'internal', 'internal.json'), '{ "name": "apex-internal" }')
  }
  return dir
}

describe('the branding switch', () => {
  it('is official with the internal folder and unofficial without, unless APEX_OFFICIAL_BRANDING says', () => {
    const maintainer = repo(true)
    const source = repo(false)
    expect(officialBranding({}, maintainer)).toBe(true)
    expect(officialBranding({}, source)).toBe(false)
    expect(officialBranding({ APEX_INTERNAL: '0' }, maintainer)).toBe(false)
    expect(officialBranding({ APEX_OFFICIAL_BRANDING: '0' }, maintainer)).toBe(false)
    expect(officialBranding({ APEX_OFFICIAL_BRANDING: '1' }, source)).toBe(true)
    expect(officialBranding({ APEX_OFFICIAL_BRANDING: ' true ' }, source)).toBe(true)
    expect(officialBranding({ APEX_OFFICIAL_BRANDING: '' }, source)).toBe(false)
    expect(() => officialBranding({ APEX_OFFICIAL_BRANDING: 'yes' }, source)).toThrow(/APEX_OFFICIAL_BRANDING/)
    expect(brandingId({}, maintainer)).toBe('official')
    expect(brandingId({}, source)).toBe('unofficial')
  })

  it('points @branding at the branding folder and puts the branding in the define', () => {
    const dir = repo(false)
    expect(brandingAlias({}, dir)['@branding']).toBe(join(dir, 'branding', 'unofficial'))
    expect(brandingAlias({ APEX_OFFICIAL_BRANDING: '1' }, dir)['@branding']).toBe(join(dir, 'branding', 'official'))
    const define = JSON.parse(brandingDefines({}, dir).__APEX_BRANDING__) as ReturnType<typeof runtimeBranding>
    expect(define).toMatchObject({ id: 'unofficial', official: false, name: 'Summit', bundleId: 'dev.summit.browser', wordmark: false })
    expect(define.hiddenPresets).toEqual(CHARACTERS.map((name) => name.toLowerCase()))
    expect(define.companion).toMatchObject({ id: 'companion', name: 'Companion' })
    expect(define.ownPreset).toMatchObject({ id: 'companion', name: 'Companion' })
    const official = runtimeBranding({ APEX_OFFICIAL_BRANDING: '1' }, dir)
    expect(official).toMatchObject({ id: 'official', official: true, name: 'Apex', shortName: 'Apex', bundleId: 'com.sennechin.apex', hiddenPresets: [], wordmark: true })
    expect(official.companion).toMatchObject({ id: 'pip', name: 'Pip' })
    expect(official.ownPreset).toBeNull()
  })

  it('takes the default bundle id from the branding; APEX_BUNDLE_ID still wins', () => {
    expect(bundleIdFrom({ APEX_OFFICIAL_BRANDING: '1' })).toBe('com.sennechin.apex')
    expect(bundleIdFrom({ APEX_OFFICIAL_BRANDING: '0' })).toBe('dev.summit.browser')
    expect(bundleIdFrom({ APEX_OFFICIAL_BRANDING: '0', APEX_BUNDLE_ID: 'org.example.browser' })).toBe('org.example.browser')
  })

  it('names the native helpers after the branding', () => {
    const out = mkdtempSync(join(tmpdir(), 'apex-helper-'))
    made.push(out)
    const plist = join(REPO, 'native', 'calendar', 'Info.plist')
    expect(helperInfoPlist(plist, out, 'calendar', { APEX_OFFICIAL_BRANDING: '1' })).toBe(plist)
    const copy = helperInfoPlist(plist, out, 'calendar', { APEX_OFFICIAL_BRANDING: '0' })
    const text = readFileSync(copy, 'utf8')
    expect(text).toContain('<string>dev.summit.browser.calendar</string>')
    expect(text).toContain('<string>Summit Calendar</string>')
    expect(text).not.toMatch(/<string>[^<]*\bApex\b/)
  })

  it('checks each branding.json', () => {
    for (const id of ['official', 'unofficial']) expect(() => readBranding(id)).not.toThrow()
    expect(() => readBranding('nightly')).toThrow(/no "nightly" branding/)
    expect(brandingProblems({})).toContain('name must be a name of 1 to 40 characters')
    expect(brandingProblems({ ...readBranding('unofficial'), hiddenPresets: ['companion'] })).toContain('the default preset cannot be hidden')
    expect(brandingProblems({ ...readBranding('unofficial'), companion: '../presets.js' })[0]).toMatch(/companion must be a .json file/)
    expect(brandingProblems({ ...readBranding('unofficial'), bundleId: 'summit' })[0]).toMatch(/reverse-DNS/)
  })

  it('offers none of Apex\'s six characters under the unofficial branding', () => {
    const unofficial = readBranding('unofficial')
    expect(unofficial.name).not.toMatch(/apex/i)
    expect(unofficial.defaultPreset).toBe('companion')
    expect(unofficial.companion).toBe('companion.json')
    const presets = JSON.parse(readFileSync(join(REPO, 'src/renderer/public/companion/config/presets.json'), 'utf8')) as Array<{ id: string }>
    // Every preset presets.json ships is one of Apex's characters, and Summit leaves each one out.
    expect(sortedIds(unofficial.hiddenPresets)).toEqual(sortedIds(presets.map((p) => p.id)))
    expect(unofficial.bundleId).not.toMatch(/apex|sennechin/i)
    expect(readBranding('official').hiddenPresets).toEqual([])
    expect(readBranding('official').companion).toBeNull()
  })
})

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort()

describe('the app reads the branding it was built with', () => {
  it('as the define says (vitest runs with the same switch as a build)', () => {
    const built = loadBranding()
    expect(BRANDING.id).toBe(built.id)
    expect(BRANDING.name).toBe(built.name)
    expect(BRANDING.bundleId).toBe(built.bundleId)
    expect(BRANDING.companion.id).toBe(built.defaultPreset)
    expect(presetOffered('pip')).toBe(built.official)
    expect(presetOffered(built.defaultPreset)).toBe(true)
  })

  it('falls back to the unofficial branding without a usable define', () => {
    for (const raw of [undefined, null, 'Apex', {}, { id: 'official' }, { id: 'nightly', name: 'X', shortName: 'X' }]) {
      const b = brandingFrom(raw)
      expect(b.id).toBe('unofficial')
      expect(b.name).toBe('Summit')
      expect(b.hiddenPresets).toContain('pip')
    }
    expect(brandingFrom({ id: 'official', name: 'Apex', shortName: 'Apex', bundleId: 'bad id', companion: { id: 'pip', name: 'Pip' } })).toMatchObject({ official: true, bundleId: 'dev.summit.browser', companion: { id: 'pip', name: 'Pip', look: null } })
  })
})

describe('the default companion comes from the branding', () => {
  const presets = JSON.parse(readFileSync(join(REPO, 'src/renderer/public/companion/config/presets.json'), 'utf8')) as CompanionPreset[]
  const official = brandingFrom(runtimeBranding({ APEX_OFFICIAL_BRANDING: '1' }))
  const unofficial = brandingFrom(runtimeBranding({ APEX_OFFICIAL_BRANDING: '0' }))

  it('is the branding\'s default preset, by name and look, on first run', () => {
    const preset = offeredPresets(presets).find((p) => p.id === BRANDING.companion.id)!
    expect(DEFAULT_PROFILE).toEqual({ name: preset.name, persona: preset.id, look: preset.look, dockIcon: false })
    // The parts system's default look is the default companion's too.
    expect(DEFAULT_LOOK).toEqual(preset.look)
    if (BRANDING.official) expect(DEFAULT_PROFILE).toMatchObject({ name: 'Pip', persona: 'pip' })
    else expect(DEFAULT_PROFILE).toMatchObject({ name: 'Companion', persona: 'companion' })
  })

  it('is Pip for Apex, with all six characters in the gallery', () => {
    expect(official.companion).toMatchObject({ id: 'pip', name: 'Pip' })
    expect(official.ownPreset).toBeNull()
    expect(offeredPresets(presets, official).map((p) => p.name)).toEqual(CHARACTERS)
  })

  it('is the unofficial branding\'s own neutral Companion, the only preset it offers', () => {
    const own = JSON.parse(readFileSync(join(REPO, 'branding/unofficial/companion.json'), 'utf8')) as CompanionPreset
    expect(unofficial.companion).toEqual({ id: 'companion', name: 'Companion', look: own.look })
    expect(unofficial.ownPreset).toEqual(own)
    // Code bundled without the build's branding reads as the unofficial branding, with this look.
    expect(PLAIN_LOOK).toEqual(own.look)
    expect(offeredPresets(presets, unofficial)).toEqual([own])
    // A whole, valid preset: every part and face id exists, and the head rules allow the look as it is.
    expect(presetSchema.safeParse(own).success).toBe(true)
    const compat = JSON.parse(readFileSync(join(REPO, 'src/renderer/public/companion/config/head-part-compatibility.json'), 'utf8')) as CompatibilityConfig
    expect(normalizeLook(own.look, compat)).toEqual(own.look)
    // A look of its own: no character's head, hair and colours.
    for (const p of presets) expect(own.look.parts.head === p.look.parts.head && own.look.colors.skin === p.look.colors.skin, p.id).toBe(false)
    for (const p of presets) expect(own.personality).not.toBe(p.personality)
  })

  it('reads in the app language where its text is the catalogue\'s, and as written otherwise', () => {
    const own = unofficial.ownPreset!
    expect(own.name).toBe(EN['galleries.ownCompanion.name'])
    expect(own.tagline).toBe(EN['galleries.ownCompanion.tagline'])
    expect(own.summary).toBe(EN['galleries.ownCompanion.summary'])
    const dutch = (key: keyof typeof NL): string => NL[key] ?? key
    expect(localizedPreset(own, unofficial, dutch)).toMatchObject({ name: NL['galleries.ownCompanion.name'], tagline: NL['galleries.ownCompanion.tagline'], summary: NL['galleries.ownCompanion.summary'] })
    expect(localizedPreset({ ...own, tagline: 'A fork\'s own words' }, unofficial, dutch).tagline).toBe('A fork\'s own words')
    // presets.json's presets keep their own text.
    expect(localizedPreset(presets[0]!, official, dutch)).toBe(presets[0])
  })

  it('a Summit build shows none of the six characters or their names', () => {
    const define = runtimeBranding({ APEX_OFFICIAL_BRANDING: '0' })
    expect(JSON.stringify({ ...define, hiddenPresets: [] })).not.toMatch(CHARACTER_NAME)
    for (const p of offeredPresets(presets, unofficial)) expect(JSON.stringify(p)).not.toMatch(CHARACTER_NAME)
    // Name suggestions and every message (Sage is also a colour, which the colour pickers name).
    expect(SETUP_NAMES.filter((n) => CHARACTER_NAME.test(n))).toEqual([])
    const colour = /^(tabs\.groupColor|workspace\.color)\.sage$/
    for (const catalogue of [EN, NL]) {
      const named = Object.entries(catalogue).filter(([key, text]) => CHARACTER_NAME.test(text) && !colour.test(key))
      expect(named).toEqual([])
    }
    if (!BRANDING.official) {
      expect(DEFAULT_PROFILE.name).toBe('Companion')
      expect(JSON.stringify(WHATS_NEW)).not.toMatch(CHARACTER_NAME)
    }
  })
})
