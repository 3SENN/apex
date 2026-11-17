/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, DEFAULT_PROFILE, PART_SLOTS, type CompanionPreset } from '@shared/companion'
import { fitsWithHat } from '@shared/companionLogic'
import { BRANDING } from '@shared/branding'
import type { Routine, Skill } from '@shared/services'
import { isInternalUrl, omniboxToUrl, parseInternalUrl } from '@shared/url'
import { uniqueFileName } from '../src/main/downloads'
import { candidateSources, chromeTimeToMs, parseChromiumBookmarks } from '../src/main/importer'
import { resolveMemoryPath } from '../src/main/memory'
import { dueRoutines } from '../src/main/routines'
import { SERVICE_SCHEMAS } from '../src/main/services'
import { chatTitle } from '../src/main/chats'
import { CompanionPresets, dockIconImage, parsePresets, pngSize, readCompatibility } from '../src/main/companion'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import {
  connectorName,
  expandSkill,
  isLegacyCompanion,
  migrateCompanion,
  nextRunAfter,
  sanitizeCompanion,
  sanitizeLook,
  validateConnectorUrl,
  validateSchedule,
} from '../src/main/stores'
import { linkFolder } from './helpers/links'

describe('routine schedules', () => {
  // Wednesday 2026-10-28 10:15 local time.
  const now = new Date(2026, 9, 28, 10, 15).getTime()

  it('runs daily routines at the next matching time', () => {
    expect(new Date(nextRunAfter({ kind: 'daily', time: '11:00', days: [] }, now))).toEqual(new Date(2026, 9, 28, 11, 0))
    expect(new Date(nextRunAfter({ kind: 'daily', time: '09:00', days: [] }, now))).toEqual(new Date(2026, 9, 29, 9, 0))
  })

  it('skips to the next allowed weekday', () => {
    // Weekdays only, asked on Friday evening: next is Monday.
    const friday = new Date(2026, 9, 30, 20, 0).getTime()
    expect(new Date(nextRunAfter({ kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, friday))).toEqual(new Date(2026, 10, 2, 8, 30))
  })

  it('adds intervals and validates input', () => {
    expect(nextRunAfter({ kind: 'interval', hours: 6 }, now)).toBe(now + 6 * 3_600_000)
    expect(() => validateSchedule({ kind: 'daily', time: '25:00', days: [] })).toThrow()
    expect(() => validateSchedule({ kind: 'daily', time: '08:00', days: [7] })).toThrow()
    expect(() => validateSchedule({ kind: 'interval', hours: 0 })).toThrow()
  })

  it('finds due routines and skips running or disabled ones', () => {
    const routine = (id: string, nextRunAt: number | null, enabled = true): Routine => ({
      id, name: id, prompt: 'p', schedule: { kind: 'interval', hours: 1 }, enabled, lastRunAt: null, nextRunAt, lastChatId: null, lastStatus: null, owner: 'shared',
    })
    const due = dueRoutines([routine('a', now - 1), routine('b', now + 1), routine('c', now - 1, false), routine('d', now - 5)], now, new Set(['d']))
    expect(due.map((r) => r.id)).toEqual(['a'])
  })
})

describe('skills', () => {
  const skill: Skill = { id: '1', name: 'weekly-report', description: '', instructions: 'Summarize my week.', updatedAt: 0, owner: 'shared', lastUsedAt: null }
  const lookup = (name: string) => (name === skill.name ? skill : undefined)

  it('expands a leading /skill with the rest of the message', () => {
    const out = expandSkill('/weekly-report focus on sales', lookup)
    expect(out.skill?.name).toBe('weekly-report')
    expect(out.text).toBe('<skill name="weekly-report">\nSummarize my week.\n</skill>\n\nfocus on sales')
  })

  it('leaves other text alone', () => {
    expect(expandSkill('/unknown thing', lookup)).toEqual({ skill: null, text: '/unknown thing' })
    expect(expandSkill('use /weekly-report later', lookup).skill).toBeNull()
  })

  it('titles chats from the first line', () => {
    expect(chatTitle('Find flights to Lisbon\nnext Friday')).toBe('Find flights to Lisbon')
    expect(chatTitle('x'.repeat(80))).toHaveLength(60)
  })
})

describe('connectors', () => {
  it('normalizes names into MCP server names', () => {
    expect(connectorName('  My Linear!! ')).toBe('my-linear')
    expect(() => connectorName('!!!')).toThrow()
  })

  it('requires https except on localhost', () => {
    expect(validateConnectorUrl('https://mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp')
    expect(validateConnectorUrl('http://localhost:3000/mcp')).toBe('http://localhost:3000/mcp')
    expect(() => validateConnectorUrl('http://mcp.example.com')).toThrow(/https/)
    expect(() => validateConnectorUrl('not a url')).toThrow()
  })
})

describe('companion profiles', () => {
  // The default companion is the branding's (Pip for Atelier, the neutral Companion for the unofficial branding).
  const presetIds = [DEFAULT_PROFILE.persona, 'nova']
  const LOOK = DEFAULT_PROFILE.look

  it('keeps valid fields over the current profile', () => {
    const out = sanitizeCompanion({
      name: '  Nova ',
      persona: 'nova',
      dockIcon: true,
      look: { rig: 'B', parts: { hat: 'hat-wizard', ears: 'ears-cat' }, face: { eyes: 'eyes-cat' }, colors: { skin: '#ABCDEF' } },
    }, DEFAULT_PROFILE, presetIds)
    expect(out).toEqual({
      name: 'Nova',
      persona: 'nova',
      dockIcon: true,
      look: {
        rig: 'B',
        parts: { ...LOOK.parts, hat: 'hat-wizard', ears: 'ears-cat' },
        face: { ...LOOK.face, eyes: 'eyes-cat' },
        colors: { ...LOOK.colors, skin: '#abcdef' },
      },
    })
  })

  it('drops invalid values', () => {
    const base = sanitizeCompanion({ look: { parts: { hat: 'hat-cap' } } })
    const out = sanitizeCompanion({
      name: '   ',
      persona: 'pirate',
      dockIcon: 'yes',
      look: {
        rig: 'Z',
        parts: { head: 'head-square', hat: 'hat-sombrero', hair: null, prop: 'prop-coffee' },
        face: { eyes: 'eyes-laser', brows: 'brows-bold', mouth: 7 },
        colors: { skin: 'red', hair: '#12345', accent: '#00FF00', outfit: '#0000000' },
      },
    }, base, presetIds)
    expect(out.name).toBe(DEFAULT_PROFILE.name)
    expect(out.persona).toBe(DEFAULT_PROFILE.persona)
    expect(out.dockIcon).toBe(false)
    expect(out.look.rig).toBe(LOOK.rig)
    // Unknown part ids empty their slot; the head keeps the current one.
    expect(out.look.parts).toEqual({ ...LOOK.parts, head: LOOK.parts.head, hat: null, hair: null, prop: 'prop-coffee' })
    expect(out.look.face).toEqual({ ...LOOK.face, brows: 'brows-bold' })
    expect(out.look.colors).toEqual({ ...LOOK.colors, accent: '#00ff00' })
    expect(sanitizeCompanion(null)).toEqual(DEFAULT_PROFILE)
  })

  it('limits names to 24 characters and accepts custom personas', () => {
    expect(sanitizeCompanion({ name: 'x'.repeat(40) }).name).toHaveLength(24)
    expect(sanitizeCompanion({ persona: 'custom' }, DEFAULT_PROFILE, presetIds).persona).toBe('custom')
    // Without a preset list (assets missing), id-shaped personas survive.
    expect(sanitizeCompanion({ persona: 'nova' }).persona).toBe('nova')
    expect(sanitizeCompanion({ persona: 'Not An Id!' }).persona).toBe(DEFAULT_PROFILE.persona)
  })

  it('never shares nested objects with its input or base', () => {
    const before = structuredClone(DEFAULT_LOOK)
    const out = sanitizeLook({}, DEFAULT_LOOK)
    out.parts.hat = 'hat-crown'
    out.colors.skin = '#000000'
    expect(DEFAULT_LOOK).toEqual(before)
  })

  it('migrates the old { name, color, accessory, eyes } profile', () => {
    const old = { name: 'Nova', color: 'mint', accessory: 'crown', eyes: 'sparkle' }
    expect(isLegacyCompanion(old)).toBe(true)
    expect(isLegacyCompanion(DEFAULT_PROFILE)).toBe(false)
    const migrated = migrateCompanion(old)
    expect(migrated).toMatchObject({ name: 'Nova', persona: 'custom', dockIcon: false })
    expect(migrated.look.parts).toEqual({ ...LOOK.parts, hat: 'hat-crown' })
    expect(migrated.look.face.eyes).toBe('eyes-sparkle')
    expect(migrated.look.colors).toEqual({ skin: '#62d6b3', hair: '#22735e', accent: '#b7f1df', outfit: '#2fae8a' })

    expect(migrateCompanion({ color: 'violet', accessory: 'headphones', eyes: 'sleepy' }).look).toMatchObject({
      parts: { earAccessory: 'headphones', hat: null },
      face: { eyes: 'eyes-sleepy' },
      colors: { skin: '#8f74f8', hair: '#4b3aa8', accent: '#c9bbff', outfit: '#6a4bff' },
    })
    for (const [accessory, hat] of [['beanie', 'hat-beanie'], ['cap', 'hat-cap'], ['flower', 'hat-flower-crown']]) {
      expect(migrateCompanion({ accessory }).look.parts.hat).toBe(hat)
    }
    const odd = migrateCompanion({ name: 42, color: 'plaid', accessory: 'sword', eyes: 'laser' })
    expect(odd.name).toBe(DEFAULT_PROFILE.name)
    expect(odd.look).toEqual(LOOK)
  })

  it('migrates an old hat by the generated part rules', () => {
    const compat = readCompatibility(fileURLToPath(new URL('../src/renderer/public/companion/config/head-part-compatibility.json', import.meta.url)))
    expect(Object.keys(compat).length).toBeGreaterThan(0)
    for (const accessory of ['beanie', 'cap', 'crown', 'flower']) {
      const { look } = migrateCompanion({ accessory }, compat)
      for (const slot of PART_SLOTS) expect(fitsWithHat(compat, look.parts.hat, slot, look.parts[slot]), `${accessory} ${slot}`).toBe(true)
    }
    // The cap does not go with Pip's tuft, so the hat wins; hair that goes with it stays.
    const hair = LOOK.parts.hair
    expect(migrateCompanion({ accessory: 'cap' }, compat).look.parts).toMatchObject({ hat: 'hat-cap', hair: fitsWithHat(compat, 'hat-cap', 'hair', hair) ? hair : null })
    if (BRANDING.official) expect(migrateCompanion({ accessory: 'cap' }, compat).look.parts.hair).toBeNull()
    expect(readCompatibility(join(tmpdir(), 'atelier-missing-rules.json'))).toEqual({})
  })

  it('reads the Dock icon size from the PNG header before anything decodes it', () => {
    const png = (width: number, height: number): string => {
      const head = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head)
      head.writeUInt32BE(13, 8)
      head.write('IHDR', 12, 'latin1')
      head.writeUInt32BE(width, 16)
      head.writeUInt32BE(height, 20)
      return `data:image/png;base64,${head.toString('base64')}`
    }
    expect(pngSize(png(512, 512))).toEqual({ width: 512, height: 512 })
    expect(pngSize('data:image/png;base64,AAAA')).toBeNull()
    expect(() => dockIconImage(png(16384, 16384))).toThrow(/at most 1024/)
    expect(() => dockIconImage(png(0, 512))).toThrow(/at most 1024/)
    expect(() => dockIconImage('data:image/png;base64,iVBORw0KGgo=')).toThrow(/at most 1024/)
  })

  it('stores migrate and sanitize on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-companion-'))
    writeFileSync(join(dir, 'companion.json'), JSON.stringify({ name: 'Bolt', color: 'sky', accessory: 'cap', eyes: 'round' }))
    const presets = (): CompanionPreset[] => presetIds.map((id) => ({ id, name: id, tagline: '', personality: '', look: DEFAULT_LOOK }))
    const store = new CompanionStore(dir, { presets })
    expect(store.get()).toMatchObject({ id: FIRST_COMPANION_ID, name: 'Bolt', persona: 'custom', look: { parts: { hat: 'hat-cap' } } })
    // The migrated profile is written to the companion list in the new format.
    expect(JSON.parse(readFileSync(join(dir, 'companions.json'), 'utf8')).companions[0].look.colors.skin).toBe('#6fb9ff')

    const changes: string[] = []
    store.on('changed', (state) => changes.push(state.items[0]?.persona ?? ''))
    store.update(FIRST_COMPANION_ID, { persona: 'nova', look: { ...DEFAULT_LOOK, rig: 'C' } })
    store.update(FIRST_COMPANION_ID, { persona: 'unknown' })
    expect(changes).toEqual(['nova', 'nova'])
    const reopened = new CompanionStore(dir, { presets })
    expect(reopened.get()).toMatchObject({ name: 'Bolt', persona: 'nova', look: { rig: 'C' } })
    // get() hands out copies.
    reopened.get().look.parts.hat = 'hat-crown'
    expect(reopened.get().look.parts.hat).toBe(DEFAULT_LOOK.parts.hat)
  })
})

describe('companion presets', () => {
  const preset = (id: string, extra: Partial<CompanionPreset> = {}): CompanionPreset => ({
    id, name: id.toUpperCase(), tagline: 't', personality: `${id} is cheerful.`, look: DEFAULT_LOOK, ...extra,
  })

  it('keeps valid, unique presets', () => {
    const { presets, rejected } = parsePresets([
      preset('pip'),
      preset('pip'),
      preset('custom'),
      preset('bad-look', { look: { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, hat: 'hat-sombrero' } } }),
      preset('nova'),
      'junk',
    ])
    expect(presets.map((p) => p.id)).toEqual(['pip', 'nova'])
    expect(rejected).toBe(4)
    expect(parsePresets({ presets: [] })).toEqual({ presets: [], rejected: 1 })
  })

  it('reads presets.json once and looks up personalities', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-presets-'))
    const file = join(dir, 'presets.json')
    const presets = new CompanionPresets(file)
    // Missing file: nothing yet, and nothing cached.
    expect(presets.list()).toEqual([])
    writeFileSync(file, JSON.stringify([preset('pip'), preset('nova')]))
    // The unofficial branding offers its own companion first, and none of Atelier's characters (src/shared/branding.ts).
    const offered = BRANDING.official ? ['pip', 'nova'] : [BRANDING.ownPreset!.id, 'nova']
    expect(presets.ids()).toEqual(offered)
    writeFileSync(file, '[]')
    expect(presets.ids()).toEqual(offered)
    expect(presets.personality('nova')).toBe('nova is cheerful.')
    expect(presets.personality('custom')).toBeUndefined()
    expect(presets.personality('ghost')).toBeUndefined()
  })
})

describe('browser import', () => {
  it('flattens Chromium bookmark trees', () => {
    const json = {
      roots: {
        bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'Docs', url: 'https://docs.example' }, { type: 'folder', children: [{ type: 'url', name: 'Deep', url: 'https://deep.example' }] }] },
        other: { type: 'folder', children: [{ type: 'url', url: 'https://untitled.example' }] },
      },
    }
    expect(parseChromiumBookmarks(json)).toEqual([
      { url: 'https://docs.example', title: 'Docs' },
      { url: 'https://deep.example', title: 'Deep' },
      { url: 'https://untitled.example', title: 'https://untitled.example' },
    ])
    expect(parseChromiumBookmarks(null)).toEqual([])
  })

  it('converts Chromium timestamps (microseconds since 1601)', () => {
    expect(chromeTimeToMs(13_380_163_200_000_000)).toBe(Date.UTC(2025, 0, 1))
    expect(chromeTimeToMs('13380163200000000')).toBe(Date.UTC(2025, 0, 1))
    expect(chromeTimeToMs(0)).toBe(0)
  })

  it('knows where browsers keep profiles on each platform', () => {
    const mac = candidateSources('darwin', '/Users/me', {})
    expect(mac.find((s) => s.id === 'chrome')?.dir).toBe(join('/Users/me/Library/Application Support/Google/Chrome/Default'))
    expect(mac.find((s) => s.id === 'firefox')?.kind).toBe('firefox')
    const win = candidateSources('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' })
    expect(win.find((s) => s.id === 'edge')?.dir).toContain(join('C:\\L', 'Microsoft', 'Edge'))
  })
})

describe('downloads', () => {
  it('picks a free file name inside the folder', () => {
    const taken = new Set(['report.pdf', 'report (1).pdf'])
    expect(uniqueFileName('report.pdf', (n) => taken.has(n))).toBe('report (2).pdf')
    expect(uniqueFileName('../../etc/passwd', () => false)).toBe('passwd')
    expect(uniqueFileName('.hidden', () => false)).toBe('hidden')
  })
})

describe('memory paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'atelier-mem-'))
  mkdirSync(join(root, 'notes'), { recursive: true })

  it('maps /memories paths into the root', () => {
    expect(resolveMemoryPath(root, '/memories/notes/a.md')).toBe(join(root, 'notes', 'a.md'))
  })

  it('refuses traversal, other prefixes and symlink escapes', () => {
    expect(() => resolveMemoryPath(root, '/memories/../secret')).toThrow()
    expect(() => resolveMemoryPath(root, '/etc/passwd')).toThrow()
    expect(() => resolveMemoryPath(root, '/memoriesX/a')).toThrow()
    linkFolder(tmpdir(), join(root, 'escape'))
    expect(() => resolveMemoryPath(root, '/memories/escape/file')).toThrow()
  })
})

describe('internal pages', () => {
  it('parses atelier:// URLs and routes them from the omnibox', () => {
    expect(parseInternalUrl('atelier://library/skills')).toEqual({ page: 'library', section: 'skills', id: null, item: null })
    expect(parseInternalUrl('atelier://history')).toEqual({ page: 'history', section: null, id: null, item: null })
    expect(parseInternalUrl('atelier://nope')).toBeNull()
    expect(isInternalUrl('https://atelier.example')).toBe(false)
    expect(omniboxToUrl('atelier://downloads', 'google')).toBe('atelier://downloads')
  })
})

describe('service schemas', () => {
  it('validate arguments for every method', () => {
    expect(SERVICE_SCHEMAS.bookmarks.toggle.safeParse(['https://a.example', 'A']).success).toBe(true)
    expect(SERVICE_SCHEMAS.bookmarks.toggle.safeParse([42]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ color: 'plaid' }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ name: 'Nova', persona: 'nova', look: DEFAULT_LOOK, dockIcon: true }]).success).toBe(true)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ look: { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, hat: 'hat-sombrero' } } }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ look: { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, head: null } } }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ look: { ...DEFAULT_LOOK, colors: { ...DEFAULT_LOOK.colors, skin: 'red' } } }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ name: '' }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.set.safeParse([{ persona: 'Bad Persona' }]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.setDockIcon.safeParse(['data:image/png;base64,iVBORw0KGgo=']).success).toBe(true)
    expect(SERVICE_SCHEMAS.companion.setDockIcon.safeParse(['data:image/jpeg;base64,/9j/4AAQ']).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.setDockIcon.safeParse([`data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`]).success).toBe(false)
    expect(SERVICE_SCHEMAS.companion.presets.safeParse([]).success).toBe(true)
    expect(SERVICE_SCHEMAS.pages.open.safeParse(['https://evil.example']).success).toBe(false)
    expect(SERVICE_SCHEMAS.routines.save.safeParse([{ name: 'n', prompt: 'p', schedule: { kind: 'interval', hours: 500 }, enabled: true }]).success).toBe(false)
  })
})
