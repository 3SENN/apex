/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { OmniboxGroup } from '@shared/omnibox'
import { applySettingsPatch, DEFAULT_SETTINGS, migrateSettings, settingsPatchSchema } from '../src/main/settings'
import { engineChoices, engineMark, goAction, startEntries, startKey, startPlan, startSuggestions, type StartKeyEvent } from '../src/renderer/src/components/newtab/searchLogic'

// NT-01: the new tab's web search. What Enter, ⌥Enter and the rows do for
// the typed text in each mode, the command bar's rows it shows, the keys,
// and the settings that remember the mode and the one-time engine choice.

const engine = { id: 'smoke', name: 'Smoke Search', template: 'https://search.test/?q=%s' }
const key = (k: string, mods: Partial<StartKeyEvent> = {}): StartKeyEvent => ({ key: k, altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...mods })

describe('new tab search plan', () => {
  it('asks the companion on Enter in companion mode, with Search on ⌥Enter', () => {
    const plan = startPlan('best pizza near me', 'companion', engine)
    expect(plan.actions.map((a) => a.kind)).toEqual(['ask', 'search'])
    expect(plan.enter).toEqual({ kind: 'ask', text: 'best pizza near me' })
    expect(plan.alt).toEqual({ kind: 'search', url: 'https://search.test/?q=best%20pizza%20near%20me', engine: 'Smoke Search', query: 'best pizza near me' })
  })

  it('searches the default engine on Enter in web mode, with Ask on ⌥Enter', () => {
    const plan = startPlan('  weather  ', 'web', engine)
    expect(plan.actions.map((a) => a.kind)).toEqual(['search', 'ask'])
    expect(plan.enter).toMatchObject({ kind: 'search', url: 'https://search.test/?q=weather' })
    expect(plan.alt).toEqual({ kind: 'ask', text: 'weather' })
  })

  it('puts Go to first for anything that looks like an address, in both modes', () => {
    for (const mode of ['companion', 'web'] as const) {
      const plan = startPlan('example.com/news', mode, engine)
      expect(plan.actions[0]).toEqual({ kind: 'go', url: 'https://example.com/news', label: 'example.com', internal: false })
      expect(plan.enter).toBe(plan.actions[0])
      expect(plan.alt?.kind).toBe(mode === 'web' ? 'ask' : 'search')
    }
    expect(goAction('localhost:5173/x', engine)).toMatchObject({ url: 'http://localhost:5173/x', internal: false })
    expect(goAction('atelier://settings/search', engine)).toMatchObject({ url: 'atelier://settings/search', label: 'atelier://settings/search', internal: true })
    expect(goAction('two words', engine)).toBeNull()
    expect(goAction('about:blank', engine)).toBeNull()
  })

  it('offers nothing for empty text', () => {
    expect(startPlan('   ', 'web', engine)).toEqual({ actions: [], enter: null, alt: null })
  })
})

describe('new tab suggestions', () => {
  const groups: OmniboxGroup[] = [
    { group: 'typed', rows: [{ id: 'typed:search', group: 'typed', title: 'ex', action: { kind: 'navigate', url: 'https://search.test/?q=ex' } }] },
    { group: 'top', rows: [{ id: 'top:1', group: 'top', title: 'Example', url: 'https://example.com/', action: { kind: 'navigate', url: 'https://example.com/' } }] },
    { group: 'ask', rows: [{ id: 'ask', group: 'ask', title: 'ex', action: { kind: 'ask', text: 'ex' } }] },
    { group: 'suggest', rows: [{ id: 'suggest:a', group: 'suggest', title: 'example', action: { kind: 'navigate', url: 'https://search.test/?q=example' } }] },
    { group: 'tabs', rows: [{ id: 'tabs:tab:1', group: 'tabs', title: 'Example tab', url: 'https://example.com/', action: { kind: 'switch-tab', tabId: 't1' } }] },
    {
      group: 'history',
      rows: Array.from({ length: 8 }, (_, i) => ({ id: `history:${i}`, group: 'history', title: `Page ${i}`, url: `https://example.com/${i}`, action: { kind: 'navigate' as const, url: `https://example.com/${i}` } })),
    },
    { group: 'commands', rows: [{ id: 'commands:x', group: 'commands', title: 'Example command', action: { kind: 'command', id: 'find' } }] },
  ]

  it('keeps the command bar’s place groups in its order, capped as a whole', () => {
    const shown = startSuggestions(groups, 'companion')
    expect(shown.map((g) => g.group)).toEqual(['top', 'tabs', 'history'])
    expect(shown.flatMap((g) => g.rows).length).toBe(6)
    // Engine suggestions only in web mode (they exist only when Settings › Search allows them).
    expect(startSuggestions(groups, 'web').map((g) => g.group)).toEqual(['top', 'suggest', 'tabs', 'history'])
  })

  it('drops rows that repeat the Go to address, but keeps the open tab to switch to', () => {
    const go = startPlan('example.com', 'web', engine).enter
    const shown = startSuggestions(groups, 'web', go)
    expect(shown.find((g) => g.group === 'top')).toBeUndefined()
    expect(shown.find((g) => g.group === 'tabs')?.rows).toHaveLength(1)
  })

  it('lists the actions first, then the rows', () => {
    const plan = startPlan('ex', 'web', engine)
    const entries = startEntries(plan, startSuggestions(groups, 'web', null, 2))
    expect(entries.map((e) => (e.kind === 'action' ? e.action.kind : e.row.id))).toEqual(['search', 'ask', 'top:1', 'suggest:a'])
  })
})

describe('new tab search keys', () => {
  const state = { open: true, count: 4, selected: -1, multiline: false }

  it('runs Enter, ⌥Enter and the selected row', () => {
    expect(startKey(key('Enter'), state)).toEqual({ kind: 'enter' })
    expect(startKey(key('Enter', { altKey: true }), state)).toEqual({ kind: 'alt' })
    expect(startKey(key('Enter'), { ...state, selected: 2 })).toEqual({ kind: 'run', index: 2 })
    expect(startKey(key('Enter', { altKey: true }), { ...state, selected: 2 })).toEqual({ kind: 'alt' })
    // Shift+Enter is a new line; an IME composition keeps its keys.
    expect(startKey(key('Enter', { shiftKey: true }), state)).toBeNull()
    expect(startKey(key('Enter', { isComposing: true }), state)).toBeNull()
  })

  it('moves through the rows with ↑ and ↓, back to the field past either end', () => {
    expect(startKey(key('ArrowDown'), state)).toEqual({ kind: 'select', index: 0 })
    expect(startKey(key('ArrowDown'), { ...state, selected: 3 })).toEqual({ kind: 'select', index: -1 })
    expect(startKey(key('ArrowUp'), state)).toEqual({ kind: 'select', index: 3 })
    expect(startKey(key('ArrowDown'), { ...state, multiline: true })).toBeNull()
    expect(startKey(key('ArrowDown'), { ...state, open: false })).toBeNull()
  })

  it('clears with Esc while the list shows, and leaves ← and → to the companion choice', () => {
    expect(startKey(key('Escape'), state)).toEqual({ kind: 'clear' })
    expect(startKey(key('Escape'), { ...state, open: false })).toBeNull()
    expect(startKey(key('ArrowLeft'), state)).toBeNull()
  })
})

describe('new tab search engines and settings', () => {
  it('draws a letter mark and offers the first engines plus the current one', () => {
    expect(engineMark('duckDuckGo')).toBe('D')
    expect(engineMark('  ')).toBe('?')
    expect(engineChoices({ id: 'google', name: 'Google', template: '' }).map((e) => e.id)).toEqual(['google', 'duckduckgo', 'bing', 'ecosia', 'brave'])
    expect(engineChoices(engine).map((e) => e.id)).toEqual(['google', 'duckduckgo', 'bing', 'ecosia', 'brave', 'smoke'])
  })

  it('remembers the mode and marks the engine chosen once one is picked anywhere', () => {
    expect(DEFAULT_SETTINGS.newTabMode).toBe('companion')
    expect(DEFAULT_SETTINGS.searchEngineChosen).toBe(false)
    expect(settingsPatchSchema.safeParse({ newTabMode: 'web' }).success).toBe(true)
    expect(settingsPatchSchema.safeParse({ newTabMode: 'images' }).success).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { newTabMode: 'web' }).searchEngineChosen).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { searchEngine: 'google' }).searchEngineChosen).toBe(true)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { searchEngine: 'google', searchEngineChosen: false }).searchEngineChosen).toBe(false)
  })

  it('treats a profile that already moved off the default engine as having chosen', () => {
    expect(migrateSettings({ searchEngine: 'duckduckgo' }).searchEngineChosen).toBe(true)
    expect(migrateSettings({ searchEngine: 'google' }).searchEngineChosen).toBe(false)
    expect(migrateSettings({ searchEngine: 'duckduckgo', searchEngineChosen: false }).searchEngineChosen).toBe(false)
    expect(migrateSettings({ newTabMode: 'web' }).newTabMode).toBe('web')
  })
})
