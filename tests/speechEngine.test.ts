/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DictationTranscript, type HelperCommand, type HelperLine, type SpeechAssets, type SpeechSessionEvent, type TranscriptionSettings } from '../src/shared/speech'
import { createSpeechBroker } from '../src/main/speech/broker'
import { createFakeSpeechHelper, createSmokeSpeechHelper, smokeSpeechAssets, type FakeLine } from '../src/main/speech/fake'
import { HelperLink } from '../src/main/speech/helper'
import { encodeCommand, parseHelperLine } from '../src/main/speech/protocol'
import { modelNotice, sameLocale } from '../src/renderer/src/speech/logic'

// macOS 26's newer engine (native/speech/Analyzer.swift, Models.swift) on the
// main side: the additive protocol fields (engine, the `assets` line and the
// `prepare` command), the broker's model queries and progress feed, the
// fakes, and what Settings › Transcription makes of a model's state.

const SETTINGS: TranscriptionSettings = {
  mic: 'built-in',
  locale: null,
  secondaryLocale: null,
  vocabulary: '',
  autoSummarize: true,
  alertCalendar: true,
  alertMeetingSites: true,
  micSensitivity: 1,
  systemSensitivity: 1,
  recordAudio: false,
  setupDismissed: false,
} as TranscriptionSettings

const LOCALES: FakeLine = {
  on: 'locales',
  lines: [
    {
      type: 'locales',
      system: 'en_GB',
      items: [
        { id: 'en_GB', name: 'English (UK)', onDevice: true, engine: 'analyzer' },
        { id: 'nl-NL', name: 'Dutch', onDevice: true, engine: 'recognizer' },
      ],
    },
  ],
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

function setup(script: FakeLine[] = [], o: { settings?: Partial<TranscriptionSettings>; platform?: NodeJS.Platform } = {}) {
  const spawn = createFakeSpeechHelper([...script, LOCALES])
  const link = new HelperLink({ path: 'fake', assumeExists: true, spawn, handshakeMs: 200, retryAfterMs: 0 })
  const broker = createSpeechBroker({ link, platform: o.platform ?? 'darwin', settings: () => ({ ...SETTINGS, ...o.settings }), startTimeoutMs: 300, stopTimeoutMs: 300, replyTimeoutMs: 150 })
  const commands = (): HelperCommand[] => spawn.last()?.commands ?? []
  const prepares = () => commands().filter((c): c is Extract<HelperCommand, { cmd: 'prepare' }> => c.cmd === 'prepare')
  return { broker, spawn, commands, prepares }
}

const assetsLine = (locale: string, state: SpeechAssets['state'], fraction: number | null): HelperLine => ({ type: 'assets', locale, state, fraction })

describe('protocol: the newer engine’s fields', () => {
  it('keeps the engine on started and on each language, and still reads an older helper without it', () => {
    const started = parseHelperLine(JSON.stringify({ type: 'started', session: 's', mode: 'meeting', onDevice: true, systemAudio: true, deviceId: null, locale: 'en-US', fallbackDevice: false, engine: 'analyzer' }))
    expect(started).toMatchObject({ type: 'started', engine: 'analyzer' })
    const older = parseHelperLine(JSON.stringify({ type: 'started', session: 's', mode: 'dictation', onDevice: true, systemAudio: false, deviceId: null, locale: 'en-US', fallbackDevice: false }))
    expect(older).not.toBeNull()
    expect(older && 'engine' in older ? older.engine : undefined).toBeUndefined()
    const locales = parseHelperLine(JSON.stringify({ type: 'locales', system: 'en-US', items: [{ id: 'en-US', name: 'English', onDevice: true, engine: 'analyzer' }, { id: 'nl-NL', name: 'Dutch', onDevice: true }] }))
    expect(locales).toMatchObject({ items: [{ id: 'en-US', engine: 'analyzer' }, { id: 'nl-NL' }] })
  })

  it('reads an engine it doesn’t know as none, without dropping the line', () => {
    const line = parseHelperLine(JSON.stringify({ type: 'started', session: 's', mode: 'dictation', onDevice: true, systemAudio: false, deviceId: null, locale: 'en-US', fallbackDevice: false, engine: 'quantum' }))
    expect(line).toMatchObject({ type: 'started', session: 's' })
    expect(line && 'engine' in line ? line.engine : undefined).toBeUndefined()
  })

  it('reads assets lines: clamps the fraction, defaults it to null, and maps an unknown state to unsupported', () => {
    expect(parseHelperLine('{"type":"assets","locale":"en-US","state":"downloading","fraction":1.2}')).toEqual({ type: 'assets', locale: 'en-US', state: 'downloading', fraction: 1 })
    expect(parseHelperLine('{"type":"assets","locale":"en-US","state":"installed"}')).toEqual({ type: 'assets', locale: 'en-US', state: 'installed', fraction: null })
    expect(parseHelperLine('{"type":"assets","locale":"fr-FR","state":"warming-up","fraction":null}')).toEqual({ type: 'assets', locale: 'fr-FR', state: 'unsupported', fraction: null })
    expect(parseHelperLine('{"type":"assets","locale":"","state":"installed","fraction":1}')).toBeNull()
  })

  it('encodes prepare as one line', () => {
    expect(encodeCommand({ cmd: 'prepare', locale: 'en-US', install: true })).toBe('{"cmd":"prepare","locale":"en-US","install":true}\n')
  })

  it('a session event carries the engine through to its listeners', async () => {
    const { broker } = setup()
    const session = await broker.begin({ purpose: 'dictation', mode: 'dictation' })
    const events: SpeechSessionEvent[] = []
    session.on((e) => events.push(e))
    await until(() => events.some((e) => e.type === 'started'))
    expect(events.find((e) => e.type === 'started')).toMatchObject({ engine: 'analyzer', onDevice: true })
  })
})

describe('broker: language models', () => {
  it('asks about the transcription language (the system one when none is set) without installing', async () => {
    const { broker, prepares } = setup()
    await expect(broker.assets()).resolves.toEqual({ locale: 'en-GB', state: 'installed', fraction: 1 })
    expect(prepares()).toEqual([{ cmd: 'prepare', locale: 'en-GB', install: false }])
  })

  it('prepares the chosen language and resolves with the first line about it, ignoring other languages', async () => {
    const { broker, prepares } = setup([
      { on: 'prepare', lines: [assetsLine('nl-NL', 'installed', 1), assetsLine('en_GB', 'downloading', 0), assetsLine('en-GB', 'installed', 1)] },
    ])
    await expect(broker.assets({ install: true })).resolves.toEqual({ locale: 'en-GB', state: 'downloading', fraction: 0 })
    expect(prepares().at(-1)).toEqual({ cmd: 'prepare', locale: 'en-GB', install: true })
  })

  it('feeds every model line to onAssets, normalised, and asks for the languages again once one is installed', async () => {
    const { broker, commands } = setup([
      { on: 'prepare', lines: [assetsLine('en_GB', 'downloading', 0), assetsLine('en_GB', 'downloading', 0.5), assetsLine('en_GB', 'installed', 1)] },
    ])
    const seen: SpeechAssets[] = []
    broker.onAssets((a) => seen.push(a))
    await broker.locales()
    await broker.assets({ install: true })
    await until(() => seen.length === 3)
    expect(seen).toEqual([
      { locale: 'en-GB', state: 'downloading', fraction: 0 },
      { locale: 'en-GB', state: 'downloading', fraction: 0.5 },
      { locale: 'en-GB', state: 'installed', fraction: 1 },
    ])
    const asked = () => commands().filter((c) => c.cmd === 'locales').length
    const before = asked()
    await broker.locales()
    expect(asked()).toBe(before + 1)
  })

  it('says unavailable off macOS (without starting the helper) and for a helper that doesn’t know prepare', async () => {
    const off = setup([], { platform: 'linux' })
    await expect(off.broker.assets()).resolves.toMatchObject({ state: 'unavailable' })
    expect(off.spawn.last()).toBeNull()
    const old = setup([{ on: 'prepare', lines: [{ type: 'error', code: 'invalid', message: 'Unknown command prepare.', fatal: false }] }])
    await expect(old.broker.assets()).resolves.toEqual({ locale: 'en-GB', state: 'unavailable', fraction: null })
  })

  it('says unsupported for a saved language the helper doesn’t list', async () => {
    const { broker, prepares } = setup([], { settings: { locale: 'xx-YY' } })
    await expect(broker.assets()).resolves.toEqual({ locale: 'xx-YY', state: 'unsupported', fraction: null })
    expect(prepares()).toEqual([])
  })
})

describe('live text from the newer engine', () => {
  it('a final clears its partial, the volatile rest comes back as a partial, and an empty partial clears it', () => {
    const transcript = new DictationTranscript()
    transcript.apply({ type: 'partial', source: 'mic', text: 'Hello there how are', startMs: 0, endMs: 1500 })
    transcript.apply({ type: 'final', source: 'mic', text: 'Hello there.', startMs: 0, endMs: 900 })
    transcript.apply({ type: 'partial', source: 'mic', text: 'how are', startMs: 900, endMs: 1500 })
    expect(transcript.text()).toBe('Hello there. how are')
    expect(transcript.apply({ type: 'partial', source: 'mic', text: '', startMs: 900, endMs: 1500 })).toBe(true)
    expect(transcript.text()).toBe('Hello there.')
    expect(transcript.finalText()).toBe('Hello there.')
  })
})

describe('fakes', () => {
  it('the default fake answers prepare with an installed model and starts on the newer engine', async () => {
    const { broker } = setup()
    await expect(broker.assets({ install: true })).resolves.toMatchObject({ state: 'installed' })
  })

  it('the smoke helper offers a model, then reports its progress and installs it', async () => {
    smokeSpeechAssets.set('supported')
    try {
      const spawn = createSmokeSpeechHelper(() => Buffer.alloc(0))
      const link = new HelperLink({ path: 'smoke', assumeExists: true, spawn, handshakeMs: 200, retryAfterMs: 0 })
      const broker = createSpeechBroker({ link, platform: 'darwin', settings: () => SETTINGS, replyTimeoutMs: 1_000 })
      const seen: SpeechAssets[] = []
      broker.onAssets((a) => seen.push(a))
      await expect(broker.assets()).resolves.toMatchObject({ locale: 'en-US', state: 'supported', fraction: null })
      await expect(broker.assets({ install: true })).resolves.toMatchObject({ state: 'downloading', fraction: 0 })
      await until(() => seen.at(-1)?.state === 'installed')
      await expect(broker.assets()).resolves.toMatchObject({ state: 'installed', fraction: 1 })
      broker.dispose()
    } finally {
      smokeSpeechAssets.reset()
    }
  })
})

describe('Settings › Transcription: the model notice', () => {
  it('maps each state, with a whole percentage only once there is progress', () => {
    const at = (state: SpeechAssets['state'], fraction: number | null = null) => modelNotice({ locale: 'en-US', state, fraction })
    expect(modelNotice(null)).toBeNull()
    expect(at('unavailable')).toBeNull()
    expect(at('unsupported')).toBeNull()
    expect(at('supported')).toEqual({ kind: 'offer' })
    expect(at('downloading', 0)).toEqual({ kind: 'preparing', percent: null })
    expect(at('downloading', null)).toEqual({ kind: 'preparing', percent: null })
    expect(at('downloading', 0.004)).toEqual({ kind: 'preparing', percent: 1 })
    expect(at('downloading', 0.426)).toEqual({ kind: 'preparing', percent: 42 })
    expect(at('downloading', 1)).toEqual({ kind: 'preparing', percent: 99 })
    expect(at('installed', 1)).toEqual({ kind: 'ready' })
    expect(at('failed')).toEqual({ kind: 'failed' })
  })

  it('matches locale ids across case and separators', () => {
    expect(sameLocale('en_US', 'EN-us')).toBe(true)
    expect(sameLocale('en-US', 'en-GB')).toBe(false)
    expect(sameLocale(null, 'en-US')).toBe(false)
  })
})
