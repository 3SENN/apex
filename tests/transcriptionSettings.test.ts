/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  HELPER_ERROR_CODES,
  SENSITIVITY,
  SessionClock,
  SpeechError,
  VOCABULARY_MAX,
  VOCABULARY_TERMS_MAX,
  VOCABULARY_TERM_MAX,
  clampSensitivity,
  encodeSpeechError,
  parseVocabulary,
  permissionsComplete,
  resolveMic,
  transcriptionReady,
  type AudioInputDevice,
  type SpeechErrorCode,
  type SpeechLocale,
  type SpeechPermissions,
} from '@shared/speech'
import { native as nativeStrings } from '@shared/i18n/en/native'
import { speech as speechStrings } from '@shared/i18n/en/speech'
import { SETTINGS_INDEX } from '@shared/settingsIndex'
import { BUILT_PAGES, settingsNav } from '../src/renderer/src/settings/logic/nav'
import { SPEECH_NOTICE_CODES, actionLabel, copyForError, errorCopy } from '../src/renderer/src/speech/errorCopy'
import {
  checklistSteps,
  currentStep,
  effectiveLocale,
  gainToSlider,
  groupLocales,
  localePrivacy,
  micMissing,
  micOptions,
  showChecklist,
  sliderToGain,
  vocabularyStats,
} from '../src/renderer/src/speech/logic'

const perms = (p: Partial<SpeechPermissions> = {}): SpeechPermissions => ({ microphone: 'not-determined', speech: 'not-determined', screen: 'denied', ...p })

const BUILT_IN: AudioInputDevice = { id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', builtIn: true, isDefault: true }
const USB: AudioInputDevice = { id: 'usb-1', name: 'Desk mic', builtIn: false, isDefault: false }

describe('vocabulary (ST-19)', () => {
  it('splits on newlines and commas, trims, collapses spaces and dedupes case-insensitively', () => {
    expect(parseVocabulary(' Pip ,\nAtelier\n\n  quarterly   review ,pip, ATELIER ')).toEqual(['Pip', 'Atelier', 'quarterly review'])
  })

  it('drops terms over the length limit and stops at the term limit', () => {
    const long = 'x'.repeat(VOCABULARY_TERM_MAX + 1)
    expect(parseVocabulary(`ok\n${long}\nfine`)).toEqual(['ok', 'fine'])
    const many = Array.from({ length: VOCABULARY_TERMS_MAX + 20 }, (_, i) => `t${i}`).join(',')
    const terms = parseVocabulary(many)
    expect(terms).toHaveLength(VOCABULARY_TERMS_MAX)
    expect(terms[0]).toBe('t0')
  })

  it('reads only the stored length', () => {
    const text = `${'a'.repeat(VOCABULARY_MAX - 2)},b,overflow`
    expect(parseVocabulary(text)).not.toContain('overflow')
  })

  it('counts what the recognizer gets and flags what it skips', () => {
    expect(vocabularyStats('')).toEqual({ chars: 0, terms: 0, tooMany: false, tooLong: false })
    expect(vocabularyStats('Pip, pip\nAtelier')).toEqual({ chars: 16, terms: 2, tooMany: false, tooLong: false })
    expect(vocabularyStats(`a\n${'y'.repeat(VOCABULARY_TERM_MAX + 1)}`).tooLong).toBe(true)
    const many = Array.from({ length: VOCABULARY_TERMS_MAX + 1 }, (_, i) => `w${i}`).join('\n')
    const stats = vocabularyStats(many)
    expect(stats.tooMany).toBe(true)
    expect(stats.terms).toBe(VOCABULARY_TERMS_MAX)
  })
})

describe('microphone choice (ST-18)', () => {
  it('resolves built-in, system default and a connected device', () => {
    expect(resolveMic('built-in', [BUILT_IN, USB])).toEqual({ deviceId: BUILT_IN.id, fallback: false })
    expect(resolveMic('system', [BUILT_IN, USB])).toEqual({ deviceId: null, fallback: false })
    expect(resolveMic('device:usb-1', [BUILT_IN, USB])).toEqual({ deviceId: 'usb-1', fallback: false })
  })

  it('falls back to the default when the saved mic is unplugged, or the Mac has no built-in one', () => {
    expect(resolveMic('device:usb-1', [BUILT_IN])).toEqual({ deviceId: null, fallback: true })
    expect(resolveMic('built-in', [USB])).toEqual({ deviceId: null, fallback: true })
    // Nothing listed at all (the helper hasn't answered): use the default quietly.
    expect(resolveMic('built-in', [])).toEqual({ deviceId: null, fallback: false })
  })

  it('keeps an unplugged saved mic listed, marked missing, and flags it for the notice', () => {
    const options = micOptions([BUILT_IN], 'device:usb-1')
    expect(options.map((o) => o.value)).toEqual(['built-in', 'system', 'device:usb-1'])
    expect(options[2]?.missing).toBe(true)
    expect(micOptions([BUILT_IN, USB], 'built-in').map((o) => o.value)).toEqual(['built-in', 'system', 'device:usb-1'])
    expect(micMissing([BUILT_IN], 'device:usb-1')).toBe(true)
    expect(micMissing([BUILT_IN, USB], 'device:usb-1')).toBe(false)
    expect(micMissing([], 'system')).toBe(false)
  })
})

describe('languages (ST-18)', () => {
  const list: { system: string; items: SpeechLocale[] } = {
    system: 'en-US',
    items: [
      { id: 'nl-NL', name: 'Dutch (Netherlands)', onDevice: false },
      { id: 'en-US', name: 'English (United States)', onDevice: true },
      { id: 'de-DE', name: 'German (Germany)', onDevice: true },
    ],
  }

  it('lists on-device languages first, each group by name', () => {
    const groups = groupLocales(list.items)
    expect(groups.onDevice.map((l) => l.id)).toEqual(['en-US', 'de-DE'])
    expect(groups.server.map((l) => l.id)).toEqual(['nl-NL'])
  })

  it('uses the system language for a null setting and says where audio goes', () => {
    expect(effectiveLocale(null, list)?.id).toBe('en-US')
    expect(localePrivacy(effectiveLocale(null, list))).toBe('on-device')
    expect(localePrivacy(effectiveLocale('nl_NL', list))).toBe('server')
    expect(localePrivacy(effectiveLocale('xx-XX', list))).toBeNull()
  })

  it('falls back to the nearest variant for a system language with no recognizer of its own', () => {
    const offered = [
      { id: 'en-US', name: 'English (United States)', onDevice: true },
      { id: 'en-GB', name: 'English (United Kingdom)', onDevice: true },
      { id: 'en-IN', name: 'English (India)', onDevice: true },
      { id: 'nl-BE', name: 'Dutch (Belgium)', onDevice: false },
      { id: 'nl-NL', name: 'Dutch (Netherlands)', onDevice: true },
      { id: 'zh-CN', name: 'Chinese (China mainland)', onDevice: true },
      { id: 'zh-TW', name: 'Chinese (Taiwan)', onDevice: true },
    ]
    const on = (system: string) => effectiveLocale(null, { system, items: offered })?.id ?? null
    // A Mac set to English (Netherlands): en-NL is European English, nearest to British.
    expect(on('en-NL')).toBe('en-GB')
    expect(on('en_DE')).toBe('en-GB')
    expect(on('en-PR')).toBe('en-US')
    expect(on('nl-SR')).toBe('nl-NL')
    // Script decides between Chinese variants: Singapore writes Simplified, Macao Traditional.
    expect(on('zh-SG')).toBe('zh-CN')
    expect(on('zh-MO')).toBe('zh-TW')
    expect(on('fr-FR')).toBeNull()
    // A language you chose is used as is, or not at all.
    expect(effectiveLocale('en-NL', { system: 'en-US', items: offered })).toBeNull()
  })
})

describe('setup checklist (ST-17)', () => {
  it('maps each permission to a step: ask first, then System Settings once refused', () => {
    expect(checklistSteps(perms(), false).map((s) => s.state)).toEqual(['ask', 'ask', 'ask'])
    expect(checklistSteps(perms({ microphone: 'granted', speech: 'denied' }), false).map((s) => s.state)).toEqual(['done', 'denied', 'ask'])
    expect(checklistSteps(perms({ microphone: 'restricted' }), true).map((s) => s.state)).toEqual(['restricted', 'ask', 'denied'])
    expect(checklistSteps(perms({ microphone: 'granted', speech: 'granted', screen: 'granted' }), true).every((s) => s.state === 'done')).toBe(true)
  })

  it('opens the first step that is not done', () => {
    expect(currentStep(checklistSteps(perms({ microphone: 'granted' }), false))?.kind).toBe('speech')
    expect(currentStep(checklistSteps(perms({ microphone: 'granted', speech: 'granted', screen: 'granted' }), false))).toBeNull()
  })

  it('hides when everything is granted, or when skipped with the essential two granted', () => {
    expect(showChecklist(null, false)).toBe(false)
    expect(showChecklist(perms(), false)).toBe(true)
    expect(showChecklist(perms(), true)).toBe(true)
    const essentials = perms({ microphone: 'granted', speech: 'granted' })
    expect(showChecklist(essentials, false)).toBe(true)
    expect(showChecklist(essentials, true)).toBe(false)
    expect(showChecklist({ ...essentials, screen: 'granted' }, false)).toBe(false)
  })

  it('is transcription-ready with microphone and speech, complete with screen too', () => {
    expect(transcriptionReady(perms({ microphone: 'granted' }))).toBe(false)
    expect(transcriptionReady(perms({ microphone: 'granted', speech: 'granted' }))).toBe(true)
    expect(permissionsComplete(perms({ microphone: 'granted', speech: 'granted' }))).toBe(false)
    expect(permissionsComplete(perms({ microphone: 'granted', speech: 'granted', screen: 'granted' }))).toBe(true)
  })
})

describe('capture levels (ST-21)', () => {
  it('clamps sensitivities and treats nonsense as 1', () => {
    expect(clampSensitivity(10)).toBe(SENSITIVITY.max)
    expect(clampSensitivity(0)).toBe(SENSITIVITY.min)
    expect(clampSensitivity(Number.NaN)).toBe(1)
  })

  it('round-trips the slider scale, with 1× in the middle', () => {
    for (const gain of [SENSITIVITY.min, 0.5, 1, 2, SENSITIVITY.max]) expect(sliderToGain(gainToSlider(gain))).toBeCloseTo(gain, 2)
    expect(gainToSlider(1)).toBe(gainToSlider(SENSITIVITY.max) / 2)
    expect(gainToSlider(SENSITIVITY.min)).toBe(0)
  })
})

describe('pause and resume (MV-10)', () => {
  it('leaves pauses out of the elapsed time', () => {
    let now = 1_000
    const clock = new SessionClock(() => now)
    expect(clock.elapsed()).toBe(0)
    clock.start()
    now += 5_000
    clock.pause()
    now += 60_000
    expect(clock.paused).toBe(true)
    expect(clock.elapsed()).toBe(5_000)
    clock.pause() // a second pause changes nothing
    clock.resume()
    now += 2_000
    expect(clock.elapsed()).toBe(7_000)
    clock.resume() // resuming while running changes nothing
    clock.pause()
    now += 1_000
    clock.resume()
    now += 500
    expect(clock.elapsed()).toBe(7_500)
  })
})

describe('error copy (MV-08)', () => {
  const ALL: SpeechErrorCode[] = [...HELPER_ERROR_CODES, 'helper-missing', 'helper-failed', 'helper-outdated', 'unsupported-platform']

  it('has Atelier words for every error and warning code', () => {
    for (const code of [...ALL, 'device-fallback', 'screen-missing', 'interrupted'] as const) {
      expect(SPEECH_NOTICE_CODES).toContain(code)
      const copy = errorCopy(code)
      expect(copy.message.length, code).toBeGreaterThan(10)
      expect(copy.message.startsWith('speech.'), code).toBe(false)
      if (copy.action) expect(actionLabel(copy.action).startsWith('speech.')).toBe(false)
    }
  })

  it('gives each MV-08 state the right action', () => {
    expect(errorCopy('helper-missing').action).toBeNull()
    expect(errorCopy('helper-failed').action).toEqual({ kind: 'retry' })
    expect(errorCopy('mic-denied').action).toEqual({ kind: 'open-settings', pane: 'microphone' })
    expect(errorCopy('speech-denied').action).toEqual({ kind: 'open-settings', pane: 'speech' })
    expect(errorCopy('screen-missing')).toMatchObject({ tone: 'warning', action: { kind: 'open-settings', pane: 'screen' } })
    expect(errorCopy('interrupted').tone).toBe('info')
    expect(errorCopy('locale-unsupported').action).toEqual({ kind: 'choose-language' })
    expect(errorCopy('device-fallback').action).toEqual({ kind: 'choose-mic' })
  })

  it('names the holder of a busy helper, and reads errors that crossed IPC', () => {
    expect(errorCopy('busy', 'meeting').message).not.toBe(errorCopy('busy').message)
    const crossed = new Error(encodeSpeechError(new SpeechError('busy', 'held', 'dictation')))
    expect(copyForError(crossed)).toEqual(errorCopy('busy', 'dictation'))
    expect(copyForError(new Error('mic-denied')).code).toBe('mic-denied')
    expect(copyForError(new Error('something else')).code).toBe('failed')
  })
})

describe('Settings › Transcription wiring (ST-05)', () => {
  it('is a built page in the Agent group', () => {
    expect(BUILT_PAGES.has('transcription')).toBe(true)
    const agent = settingsNav(BUILT_PAGES, 'darwin').find((g) => g.id === 'agent')
    expect(agent?.entries.some((e) => e.kind === 'page' && e.id === 'transcription')).toBe(true)
  })

  it('indexes its rows with real titles and unique anchors', () => {
    const rows = SETTINGS_INDEX.filter((e) => e.page === 'transcription')
    expect(rows.length).toBeGreaterThanOrEqual(8)
    // The lid-pause row lives on this page with its title in the native strings.
    const titles = [...Object.keys(speechStrings), ...Object.keys(nativeStrings)]
    for (const row of rows) expect(titles).toContain(row.title)
    expect(rows.some((r) => r.anchor === 'lid-pause' && r.title.startsWith('native.'))).toBe(true)
    expect(new Set(rows.map((r) => r.anchor)).size).toBe(rows.length)
  })
})
