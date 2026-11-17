/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, applySettingsPatch, migrateSettings, settingsPatchSchema } from '../src/main/settings'
import { NESTED_SETTINGS_DEFAULTS, normalizeNestedSettings } from '../src/main/nestedSettings'

// The voice, transcription, autofill and meeting-card settings groups: defaults, field-by-field fallback inside a
// nested group, the one-level patch merge and the cross-field rules.

describe('voice, transcription and autofill settings', () => {
  it('has the defaults', () => {
    expect(DEFAULT_SETTINGS.voice).toEqual(NESTED_SETTINGS_DEFAULTS.voice)
    expect(DEFAULT_SETTINGS.voice).toMatchObject({ holdToTalk: false, chord: 'alt+space', readAloudModifier: 'shift', target: 'auto', launcher: false })
    expect(DEFAULT_SETTINGS.transcription).toMatchObject({ mic: 'built-in', locale: null, secondaryLocale: 'none', vocabulary: '', autoSummarize: true, recordAudio: true, recordOnly: false, micSensitivity: 1 })
    expect(DEFAULT_SETTINGS.autofill).toMatchObject({ offerLogins: true, offerSave: true, cards: true, cardAuth: true, passwordsImported: false })
    expect(DEFAULT_SETTINGS.meetingCards).toEqual({ all: false, kinds: [], sites: [] })
    expect(DEFAULT_SETTINGS.sidebar.destinations.meetings).toBe(true)
  })

  it('migrates an older file: the new groups come in at their defaults and nothing else changes', () => {
    const settings = migrateSettings({ theme: 'dark', layout: 'horizontal', sidebar: { destinations: { chats: true, routines: false, skills: true, connectors: true } } })
    expect(settings.theme).toBe('dark')
    expect(settings.layout).toBe('horizontal')
    expect(settings.sidebar.destinations).toMatchObject({ routines: false, meetings: true })
    expect(settings.voice).toEqual(NESTED_SETTINGS_DEFAULTS.voice)
    expect(settings.transcription).toEqual(NESTED_SETTINGS_DEFAULTS.transcription)
  })

  it('falls back one bad nested field on its own', () => {
    const settings = migrateSettings({ voice: { holdToTalk: true, chord: 'cmd+space', sounds: false }, transcription: { locale: 'not a locale!', vocabulary: 'Apex' } })
    expect(settings.voice).toMatchObject({ holdToTalk: true, chord: 'alt+space', sounds: false })
    expect(settings.transcription).toMatchObject({ locale: null, vocabulary: 'Apex' })
  })

  it('merges a patch one level deep', () => {
    const patch = settingsPatchSchema.parse({ voice: { holdToTalk: true }, meetingCards: { sites: ['Meet.Google.com'] } })
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch)
    expect(next.voice).toEqual({ ...NESTED_SETTINGS_DEFAULTS.voice, holdToTalk: true })
    expect(next.meetingCards).toEqual({ all: false, kinds: [], sites: ['meet.google.com'] })
    expect(next.transcription).toEqual(NESTED_SETTINGS_DEFAULTS.transcription)
  })

  it('rejects unknown fields inside a group', () => {
    expect(() => settingsPatchSchema.parse({ voice: { holdToTalk: true, extra: 1 } })).toThrow()
    expect(() => settingsPatchSchema.parse({ autofill: { cvc: '123' } })).toThrow()
  })

  it('keeps the read-aloud modifier out of the chord', () => {
    const a = normalizeNestedSettings({ ...DEFAULT_SETTINGS, voice: { ...NESTED_SETTINGS_DEFAULTS.voice, chord: 'ctrl+alt+space', readAloudModifier: 'ctrl' } })
    expect(a.voice.readAloudModifier).toBe('shift')
    const b = normalizeNestedSettings({ ...DEFAULT_SETTINGS, voice: { ...NESTED_SETTINGS_DEFAULTS.voice, chord: 'ctrl+shift+space', readAloudModifier: 'shift' } })
    expect(b.voice.readAloudModifier).toBe('cmd')
    const c = migrateSettings({ voice: { chord: 'ctrl+alt+space', readAloudModifier: 'ctrl' } })
    expect(c.voice.readAloudModifier).not.toBe('ctrl')
  })

  it('trims vocabulary, clamps sensitivities and cleans muted sites', () => {
    const settings = migrateSettings({
      transcription: { vocabulary: 'x'.repeat(5000), micSensitivity: 9, systemSensitivity: 0.01 },
      meetingCards: { sites: ['A.example', 'a.example', ' b.example ', ...Array.from({ length: 300 }, (_, i) => `s${i}.example`)] },
    })
    expect(settings.transcription.vocabulary).toHaveLength(2000)
    expect(settings.transcription.micSensitivity).toBe(4)
    expect(settings.transcription.systemSensitivity).toBe(0.25)
    expect(settings.meetingCards.sites.slice(0, 2)).toEqual(['a.example', 'b.example'])
    expect(settings.meetingCards.sites).toHaveLength(200)
  })
})
