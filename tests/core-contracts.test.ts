/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { applyContributions, registerMenuContribution, type MenuState } from '@shared/menuModel'
import { PASSIVE_SURFACES, SURFACE_IDS, isSurfaceId, surfaceTier } from '@shared/overlay'
import { SHORTCUTS, SHORTCUT_IDS, formatKeys, isCommandId } from '@shared/shortcuts'
import { displayHost } from '@shared/domains'
import { CommandRegistry } from '../src/main/commands'
import { mergeServices, missingMethods } from '../src/main/features'
import { log, redact, registerSecret } from '../src/main/log'
import { omnibox } from '../src/main/omnibox'
import { registerPageMenuSection, buildPageMenu } from '../src/main/pageMenu'
import { registerResetStep, runResetSteps } from '../src/main/reset'
import { normalizeAccelerator, shortcuts } from '../src/main/shortcuts'
import { measureStorage, registerStorageCategory } from '../src/main/storage'
import { selectedGroups } from '../src/main/smokeGroups'
import { shouldNotify } from '../src/main/notifications'
import type { Services } from '@shared/services'

// The core contracts: the tables are well formed and the registries
// features plug into behave as documented.

describe('surface ids', () => {
  it('are unique and known', () => {
    expect(new Set(SURFACE_IDS).size).toBe(SURFACE_IDS.length)
    expect(isSurfaceId('command-bar')).toBe(true)
    expect(isSurfaceId('tabs-used')).toBe(false)
    expect(isSurfaceId('nope')).toBe(false)
  })
  it('put the passive surfaces on the passive tier', () => {
    for (const id of PASSIVE_SURFACES) expect(surfaceTier(id)).toBe('passive')
    expect(surfaceTier('dialog')).toBe('interactive')
  })
})

describe('the shortcut table', () => {
  it('has one row per id and no two rows on one chord', () => {
    expect(SHORTCUTS.map((s) => s.id).sort()).toEqual([...SHORTCUT_IDS].sort())
    for (const platform of ['darwin', 'win32']) {
      const chords = SHORTCUTS.filter((s) => !s.accelerator.startsWith('Hold+')).map((s) => normalizeAccelerator(platform === 'darwin' ? s.keys.mac : s.keys.other, platform))
      expect(new Set(chords).size, platform).toBe(chords.length)
    }
  })
  it('formats key caps per platform', () => {
    const def = SHORTCUTS.find((s) => s.id === 'reopen-closed')
    if (!def) throw new Error('missing row')
    expect(formatKeys(def, 'darwin')).toEqual(['⇧', '⌘', 'T'])
    expect(formatKeys(def, 'win32')).toEqual(['Ctrl', 'Shift', 'T'])
    expect(formatKeys({ keys: { mac: 'Hold+Cmd', other: 'Hold+Ctrl' } }, 'darwin')).toEqual(['Hold', '⌘'])
    expect(formatKeys({ keys: { mac: 'Cmd+Plus', other: 'Ctrl+Plus' } }, 'darwin')).toEqual(['⌘', '+'])
  })
  it('knows command ids', () => {
    expect(isCommandId('focus-mode')).toBe(true)
    expect(isCommandId('qr-code')).toBe(true)
    expect(isCommandId('launch-rockets')).toBe(false)
  })
})

describe('runtime shortcuts and interceptors', () => {
  it('refuses a chord the table already uses', () => {
    const clash = shortcuts.registerRuntime({ id: 'x', owner: 'ext', title: 'X', accelerator: 'CmdOrCtrl+T', keys: { mac: 'Cmd+T', other: 'Ctrl+T' }, group: 'tools', overridesPage: false, when: 'any' })
    expect(clash).toEqual({ ok: false, clash: 'new-tab' })
    const ok = shortcuts.registerRuntime({ id: 'y', owner: 'ext', title: 'Y', accelerator: 'Alt+Shift+Y', keys: { mac: 'Alt+Shift+Y', other: 'Alt+Shift+Y' }, group: 'tools', overridesPage: false, when: 'any' })
    expect(ok.ok).toBe(true)
    expect(shortcuts.runtime().map((s) => s.id)).toContain('y')
    if (ok.ok) ok.dispose()
    expect(shortcuts.runtime().map((s) => s.id)).not.toContain('y')
  })
  it('runs interceptors highest priority first and stops at handled', () => {
    const order: string[] = []
    const a = shortcuts.addInputInterceptor(() => (order.push('low'), 'pass'), { priority: 1 })
    const b = shortcuts.addInputInterceptor(() => (order.push('high'), 'handled'), { priority: 10 })
    expect(shortcuts.intercept({} as Electron.Input, {} as Electron.WebContents, null)).toBe(true)
    expect(order).toEqual(['high'])
    b()
    expect(shortcuts.intercept({} as Electron.Input, {} as Electron.WebContents, null)).toBe(false)
    expect(order).toEqual(['high', 'low'])
    a()
  })
})

describe('the command registry', () => {
  it('runs the last matching intercept instead of the command', async () => {
    const reg = new CommandRegistry()
    const ran: string[] = []
    reg.register('find', () => void ran.push('base'))
    const off = reg.intercept('find', { when: () => true, run: () => void ran.push('first') })
    reg.intercept('find', { when: () => false, run: () => void ran.push('never') })
    await reg.run('find', null)
    expect(ran).toEqual(['first'])
    off()
    await reg.run('find', null)
    expect(ran).toEqual(['first', 'base'])
  })
  it('reports state and skips disabled commands', async () => {
    const reg = new CommandRegistry()
    const run = vi.fn()
    reg.register('print', run, { enabled: () => false, checked: () => true })
    expect(reg.available(null).print).toEqual({ enabled: false, checked: true })
    expect(await reg.run('print', null)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(() => reg.register('print', run)).toThrow()
  })
})

describe('menu contributions', () => {
  it('insert after the named item or at the end', () => {
    const state = {} as MenuState
    const off1 = registerMenuContribution({ id: 'test-a', target: 'help', after: 'one', build: () => [{ id: 'a', label: 'A' }] })
    const off2 = registerMenuContribution({ id: 'test-b', target: 'help', build: () => [{ id: 'b', label: 'B' }] })
    const out = applyContributions('help', [{ id: 'one', label: '1' }, { id: 'two', label: '2' }], state)
    expect(out.map((i) => i.id)).toEqual(['one', 'a', 'two', 'b'])
    off1()
    off2()
    expect(applyContributions('help', [], state)).toEqual([])
  })
})

describe('page menu sections', () => {
  it('build in order with separators between non-empty sections', () => {
    const offs = [
      registerPageMenuSection({ id: 'late', order: 90, build: () => [{ label: 'Inspect' }] }),
      registerPageMenuSection({ id: 'empty', order: 20, build: () => [] }),
      registerPageMenuSection({ id: 'early', order: 10, build: () => [{ label: 'Open link' }] }),
    ]
    const items = buildPageMenu({} as Electron.ContextMenuParams, {} as never, {} as never)
    expect(items.map((i) => i.label ?? i.type)).toEqual(['Open link', 'separator', 'Inspect'])
    for (const off of offs) off()
  })
})

describe('storage, reset and notifications', () => {
  it('measure categories in order and survive a failing one', async () => {
    const offs = [
      registerStorageCategory({ id: 'b', label: 'B', order: 2, measure: async () => 5 }),
      registerStorageCategory({ id: 'a', label: 'A', order: 1, measure: async () => Promise.reject(new Error('nope')) }),
    ]
    expect((await measureStorage()).map((c) => [c.id, c.bytes])).toEqual([['a', 0], ['b', 5]])
    for (const off of offs) off()
  })
  it('runs secret reset steps only when asked', async () => {
    const offs = [
      registerResetStep({ id: 'plain', order: 1, label: 'Plain', run: async () => ({ removed: ['plain'] }) }),
      registerResetStep({ id: 'vault', order: 2, label: 'Vault', secrets: true, run: async () => ({ removed: ['vault'] }) }),
    ]
    expect((await runResetSteps({ secrets: false, dryRun: true })).removed).toEqual(['plain'])
    expect((await runResetSteps({ secrets: true, dryRun: true })).removed).toEqual(['plain', 'vault'])
    for (const off of offs) off()
  })
  it('suppresses notifications by switch, category, mute and view', () => {
    const ctx = { enabled: true, categories: { downloads: true, 'needs-you': false }, mutedChat: (id: string) => id === 'm', chatInView: (id: string) => id === 'v' }
    expect(shouldNotify({ category: 'downloads', target: {} }, ctx)).toBe(true)
    expect(shouldNotify({ category: 'needs-you', target: {} }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'downloads', target: { chatId: 'm' } }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'downloads', target: { chatId: 'v' } }, ctx)).toBe(false)
    expect(shouldNotify({ category: 'downloads', target: {} }, { ...ctx, enabled: false })).toBe(false)
  })
})

describe('command-bar providers', () => {
  it('group rows in provider order, capped, skipping failures', async () => {
    const offs = [
      omnibox.registerProvider({ id: 'p2', group: 'tabs', order: 2, maxRows: 1, query: async () => [1, 2].map((n) => ({ id: `t${n}`, group: 'tabs', title: `Tab ${n}`, action: { kind: 'switch-tab' as const, tabId: `t${n}` } })) }),
      omnibox.registerProvider({ id: 'p1', group: 'ask', order: 1, maxRows: 3, query: async (text) => [{ id: 'ask', group: 'ask', title: text, action: { kind: 'ask' as const, text } }] }),
      omnibox.registerProvider({ id: 'bad', group: 'bad', order: 3, maxRows: 3, query: async () => Promise.reject(new Error('down')) }),
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const groups = await omnibox.query('hello', { windowId: 1, signal: new AbortController().signal })
    expect(groups.map((g) => [g.group, g.rows.length])).toEqual([['ask', 1], ['tabs', 1]])
    warn.mockRestore()
    for (const off of offs) off()
  })
})

describe('the log facade', () => {
  it('redacts registered secrets and credential shapes', () => {
    registerSecret('super-secret-value')
    expect(redact('key=super-secret-value!')).toBe('key=[redacted]!')
    expect(redact('Authorization: Bearer abcdefgh12345')).toBe('Authorization: [redacted]')
    expect(redact('sk-ant-abcdefghijk')).toBe('[redacted]')
    const seen: string[] = []
    const off = log.onEntry((e) => void seen.push(e.message))
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    log.info('test', 'token super-secret-value')
    info.mockRestore()
    off()
    expect(seen).toEqual(['token [redacted]'])
  })
})

describe('service merging', () => {
  it('merges namespaces method by method and finds gaps', () => {
    const merged = mergeServices({ tabs: { move: () => undefined } } as never, { tabs: { recent: () => [] } } as never) as unknown as Record<string, Record<string, unknown>>
    expect(Object.keys(merged.tabs ?? {})).toEqual(['move', 'recent'])
    expect(missingMethods(merged as unknown as Services, { tabs: { move: 1, recent: 1, thumbnail: 1 } })).toEqual(['tabs.thumbnail'])
  })
})

describe('smoke groups and domains', () => {
  it('select groups from ATELIER_SMOKE_ONLY', () => {
    const groups = [{ group: 'BROWSER' as const, checks: [], shots: [] }, { group: 'VOICE-PASSWORDS' as const, checks: [], shots: [] }]
    expect(selectedGroups(undefined, groups).map((g) => g.group)).toEqual(['BROWSER', 'VOICE-PASSWORDS'])
    expect(selectedGroups('voice-passwords', groups).map((g) => g.group)).toEqual(['VOICE-PASSWORDS'])
    expect(selectedGroups(' browser ,maintenance', groups).map((g) => g.group)).toEqual(['BROWSER'])
  })
  it('shows the registrable domain and flags punycode', () => {
    expect(displayHost('https://news.bbc.co.uk/x')).toMatchObject({ host: 'news.bbc.co.uk', registrable: 'bbc.co.uk', punycodeWarning: false })
    expect(displayHost('https://xn--pple-43d.com/').punycodeWarning).toBe(true)
    expect(displayHost('not a url').host).toBe('')
  })
})
