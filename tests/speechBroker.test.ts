/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HelperCommand, HelperLine, SpeechSessionEvent, SpeechStatus, TranscriptionSettings } from '../src/shared/speech'
import { createSpeechBroker } from '../src/main/speech/broker'
import { createFakeSpeechHelper, type FakeLine } from '../src/main/speech/fake'
import { HelperLink } from '../src/main/speech/helper'
import { createMicTest } from '../src/main/speech/micTest'
import { createScreenAccess, screenAccessFrom, screenPromptFile, type ScreenPrompt } from '../src/main/speech/screenAccess'

// The SpeechBroker over the scripted fake helper: one session at a time,
// settings resolved at each start, events per session, crashes and cancels.

const SETTINGS: TranscriptionSettings = {
  mic: 'built-in',
  locale: null,
  secondaryLocale: null,
  vocabulary: 'Atelier, Pip\nAtelier',
  autoSummarize: true,
  alertCalendar: true,
  alertMeetingSites: true,
  micSensitivity: 9,
  systemSensitivity: 0.5,
  recordAudio: false,
  recordOnly: false,
  setupDismissed: false,
  alertDesktopCalls: true,
  desktopCallsMuted: [],
}

const DEVICES: FakeLine = {
  on: 'devices',
  lines: [{ type: 'devices', items: [{ id: 'usb-1', name: 'USB Mic', builtIn: false, isDefault: true }, { id: 'builtin', name: 'Built-in', builtIn: true, isDefault: false }] }],
}
const LOCALES: FakeLine = {
  on: 'locales',
  lines: [{ type: 'locales', system: 'en_GB', items: [{ id: 'en_GB', name: 'English (UK)', onDevice: true }, { id: 'nl-NL', name: 'Dutch', onDevice: false }] }],
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

function setup(script: FakeLine[] = [], o: { settings?: Partial<TranscriptionSettings>; platform?: NodeJS.Platform; spawn?: ReturnType<typeof createFakeSpeechHelper>; screenPrompt?: ScreenPrompt; preferred?: string[] } = {}) {
  const spawn = o.spawn ?? createFakeSpeechHelper([...script, DEVICES, LOCALES])
  const link = new HelperLink({ path: 'fake', assumeExists: true, spawn, handshakeMs: 200, retryAfterMs: 0 })
  const statuses: SpeechStatus[] = []
  const broker = createSpeechBroker({ link, platform: o.platform ?? 'darwin', settings: () => ({ ...SETTINGS, ...o.settings }), startTimeoutMs: 300, stopTimeoutMs: 300, replyTimeoutMs: 300, screenPrompt: o.screenPrompt, preferredLanguages: () => o.preferred ?? [] })
  broker.onStatus((s) => statuses.push(s))
  const commands = (): HelperCommand[] => spawn.last()?.commands ?? []
  const lastStart = (): Extract<HelperCommand, { cmd: 'start' }> | undefined => commands().filter((c): c is Extract<HelperCommand, { cmd: 'start' }> => c.cmd === 'start').at(-1)
  return { broker, link, spawn, statuses, commands, lastStart }
}

function collect(session: { on(fn: (e: SpeechSessionEvent) => void): () => void }): SpeechSessionEvent[] {
  const events: SpeechSessionEvent[] = []
  session.on((e) => events.push(e))
  return events
}

describe('SpeechBroker', () => {
  it('starts with the settings resolved: built-in mic, system locale, vocabulary and clamped gains', async () => {
    const { broker, lastStart } = setup()
    const session = await broker.begin({ purpose: 'dictation', mode: 'dictation', levels: true })
    expect(lastStart()).toMatchObject({
      session: session.id,
      mode: 'dictation',
      locale: 'en-GB',
      deviceId: 'builtin',
      contextualStrings: ['Atelier', 'Pip'],
      micGain: 4,
      systemGain: 0.5,
      transcribe: true,
      levels: true,
      record: null,
    })
    expect(broker.status().active).toEqual({ id: session.id, purpose: 'dictation', mode: 'dictation' })
  })

  it('refuses a second start with a busy error naming the holder', async () => {
    const { broker } = setup()
    await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).rejects.toMatchObject({ code: 'busy', holder: 'meeting' })
    await expect(broker.transcribeFile('/x.m4a', () => {})).rejects.toMatchObject({ code: 'busy', holder: 'meeting' })
  })

  it('fans events out to their own session, without the session id, started first', async () => {
    const { broker, spawn } = setup([
      {
        on: 'start',
        lines: [
          { type: 'started', session: '$session', mode: 'dictation', onDevice: true, systemAudio: false, deviceId: null, locale: 'en-GB', fallbackDevice: false },
          { type: 'partial', session: '$session', source: 'mic', text: 'hel', startMs: 0, endMs: 100 },
          { type: 'partial', session: 'someone-else', source: 'mic', text: 'nope', startMs: 0, endMs: 100 },
          { type: 'final', session: '$session', source: 'mic', text: 'Hello.', startMs: 0, endMs: 300 },
        ],
      },
    ])
    const session = await broker.begin({ purpose: 'dictation', mode: 'dictation' })
    const events = collect(session)
    await until(() => events.length >= 3)
    expect(events.map((e) => e.type)).toEqual(['started', 'partial', 'final'])
    expect(events[2]).toEqual({ type: 'final', source: 'mic', text: 'Hello.', startMs: 0, endMs: 300 })
    expect(spawn.last()).not.toBeNull()
  })

  it('bilingual: a meeting listens in the Mac’s next language too and keeps, per stretch, the language that fits', async () => {
    const { broker, lastStart } = setup(
      [
        {
          on: 'start',
          lines: [
            { type: 'started', session: '$session', mode: 'meeting', onDevice: true, systemAudio: true, deviceId: 'builtin', locale: 'en-GB', fallbackDevice: false, secondaryLocale: 'nl-NL' },
            { type: 'partial', session: '$session', source: 'mic', text: 'hue de', startMs: 0, endMs: 400, locale: 'en-GB' },
            { type: 'partial', session: '$session', source: 'mic', text: 'goede', startMs: 0, endMs: 400, locale: 'nl-NL' },
            { type: 'final', session: '$session', source: 'mic', text: 'Hue de mortion alimal', startMs: 0, endMs: 1800, locale: 'en-GB', fit: 0.4 },
            { type: 'final', session: '$session', source: 'mic', text: 'Goedemorgen allemaal', startMs: 0, endMs: 1700, locale: 'nl-NL', fit: 1 },
            { type: 'final', session: '$session', source: 'mic', text: 'Thanks, everyone.', startMs: 2000, endMs: 2900, locale: 'en-GB', fit: 0.9 },
          ],
        },
      ],
      { preferred: ['en-NL', 'nl-NL'] },
    )
    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    expect(lastStart()).toMatchObject({ locale: 'en-GB', secondaryLocale: 'nl-NL' })
    const events = collect(session)
    await until(() => events.some((e) => e.type === 'partial'))
    await session.stop()
    await until(() => events.some((e) => e.type === 'stopped'))
    // Captions show the first language until the other wins a stretch; the finals keep what fits.
    expect(events.filter((e) => e.type === 'partial').map((e) => (e as { text: string }).text)).toEqual(['hue de'])
    expect(events.flatMap((e) => (e.type === 'final' ? [e.text] : []))).toEqual(['Goedemorgen allemaal', 'Thanks, everyone.'])
  })

  it('bilingual stays off with One language only, and for dictation', async () => {
    const off = setup([], { preferred: ['en-NL', 'nl-NL'], settings: { secondaryLocale: 'none' } })
    await off.broker.begin({ purpose: 'meeting', mode: 'meeting' })
    expect(off.lastStart()).not.toHaveProperty('secondaryLocale')
    const dictation = setup([], { preferred: ['en-NL', 'nl-NL'] })
    await dictation.broker.begin({ purpose: 'dictation', mode: 'dictation' })
    expect(dictation.lastStart()).not.toHaveProperty('secondaryLocale')
    // Windows' helper hears one language: a second one chosen (as a Mac would ask for it) isn't asked for.
    const mac = setup([], { settings: { secondaryLocale: 'nl-NL' } })
    await mac.broker.begin({ purpose: 'meeting', mode: 'meeting' })
    expect(mac.lastStart()).toMatchObject({ secondaryLocale: 'nl-NL' })
    const windows = setup([], { platform: 'win32', settings: { secondaryLocale: 'nl-NL' } })
    await windows.broker.begin({ purpose: 'meeting', mode: 'meeting' })
    expect(windows.lastStart()).not.toHaveProperty('secondaryLocale')
  })

  it('warns when the saved microphone is unplugged and uses the default', async () => {
    const { broker, lastStart } = setup([], { settings: { mic: 'device:gone' } })
    const session = await broker.begin({ purpose: 'dictation', mode: 'dictation' })
    const events = collect(session)
    await until(() => events.some((e) => e.type === 'warning'))
    expect(lastStart()?.deviceId).toBeNull()
    expect(events).toContainEqual({ type: 'warning', code: 'device-fallback' })
  })

  it('warns when a meeting runs without system audio (Screen Recording missing)', async () => {
    const { broker } = setup([
      { on: 'start', lines: [{ type: 'started', session: '$session', mode: 'meeting', onDevice: true, systemAudio: false, deviceId: 'builtin', locale: 'en-GB', fallbackDevice: false }] },
    ])
    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    const events = collect(session)
    await until(() => events.length >= 2)
    expect(events).toContainEqual({ type: 'warning', code: 'screen-missing' })
  })

  it('turns a fatal start error into a SpeechError and frees the helper', async () => {
    const { broker } = setup([
      { on: 'start', once: true, lines: [{ type: 'error', session: '$session', code: 'mic-denied', message: 'denied', fatal: true }] },
    ])
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).rejects.toMatchObject({ code: 'mic-denied' })
    expect(broker.status().active).toBeNull()
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).resolves.toBeTruthy()
  })

  it('refuses a language the recognizer does not support, before starting', async () => {
    const { broker, lastStart } = setup([], { settings: { locale: 'xx-YY' } })
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).rejects.toMatchObject({ code: 'locale-unsupported' })
    expect(lastStart()).toBeUndefined()
    // The caller's locale wins over settings.
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation', locale: 'nl_NL' })).resolves.toBeTruthy()
    expect(lastStart()?.locale).toBe('nl-NL')
  })

  it('listens in the nearest variant when the Mac’s own language has no recognizer (en-NL → en-GB)', async () => {
    const dutchMac: FakeLine = {
      on: 'locales',
      lines: [{ type: 'locales', system: 'en_NL', items: [{ id: 'en-US', name: 'English (US)', onDevice: true }, { id: 'en_GB', name: 'English (UK)', onDevice: true }, { id: 'nl-NL', name: 'Dutch', onDevice: true }] }],
    }
    const { broker, lastStart } = setup([dutchMac])
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).resolves.toBeTruthy()
    expect(lastStart()?.locale).toBe('en-GB')
  })

  it('stops with the duration and the recording', async () => {
    const { broker } = setup([{ on: 'stop', lines: [{ type: 'stopped', session: '$session', durationMs: 4200, audio: { path: '/tmp/x.m4a', bytes: 99 } }] }])
    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting', record: '/tmp/x.m4a' })
    await expect(session.stop()).resolves.toEqual({ durationMs: 4200, audio: { path: '/tmp/x.m4a', bytes: 99 } })
    // Stopping again gives the same answer, and the helper is free.
    await expect(session.stop()).resolves.toMatchObject({ durationMs: 4200 })
    expect(broker.status().active).toBeNull()
  })

  it('pauses and resumes through the helper', async () => {
    const { broker, commands } = setup()
    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    const events = collect(session)
    session.pause()
    await until(() => events.some((e) => e.type === 'paused'))
    session.pause()
    session.resume()
    await until(() => events.some((e) => e.type === 'resumed'))
    expect(commands().filter((c) => c.cmd === 'pause' || c.cmd === 'resume').map((c) => c.cmd)).toEqual(['pause', 'resume'])
  })

  it('ends the session with helper-failed when the helper dies, then restarts it', async () => {
    const { broker, spawn } = setup()
    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    const events = collect(session)
    const first = spawn.last()
    first?.kill()
    await until(() => events.some((e) => e.type === 'error'))
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'helper-failed', fatal: true })
    await expect(session.stop()).resolves.toEqual({ durationMs: expect.any(Number), audio: null })
    expect(broker.status().active).toBeNull()
    await until(() => spawn.last() !== first)
    await expect(broker.begin({ purpose: 'dictation', mode: 'dictation' })).resolves.toBeTruthy()
  })

  it('ends a session whose stop is never answered, and restarts the helper', async () => {
    const { broker, spawn } = setup([{ on: 'stop', lines: [] }])
    const session = await broker.begin({ purpose: 'dictation', mode: 'dictation' })
    const first = spawn.last()
    await expect(session.stop()).resolves.toMatchObject({ audio: null })
    expect(broker.status().active).toBeNull()
    await broker.devices()
    expect(spawn.last()).not.toBe(first)
  })

  it('cancels: no more events, the recording is thrown away, and the next start waits for the helper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-speech-'))
    const record = join(dir, 'audio.m4a')
    const { broker } = setup([
      {
        on: 'stop',
        delayMs: 20,
        lines: [{ type: 'stopped', session: '$session', durationMs: 10, audio: { path: record, bytes: 3 } }],
      },
    ])
    const session = await broker.begin({ purpose: 'voice-command', mode: 'dictation', record })
    writeFileSync(record, 'abc')
    const events = collect(session)
    session.cancel()
    expect(broker.status().active).toBeNull()
    const next = await broker.begin({ purpose: 'dictation', mode: 'dictation' })
    expect(next.id).not.toBe(session.id)
    expect(events.some((e) => e.type === 'stopped')).toBe(false)
    await until(() => !existsSync(record))
  })

  it('transcribes a file and finishes on stopped', async () => {
    const { broker, commands } = setup([
      {
        on: 'transcribe',
        lines: [
          { type: 'progress', session: '$session', fraction: 0.5 },
          { type: 'final', session: '$session', source: 'mic', text: 'From the file.', startMs: 0, endMs: 900 },
          { type: 'progress', session: '$session', fraction: 1 },
          { type: 'stopped', session: '$session', durationMs: 900, audio: null },
        ],
      },
    ])
    const events: SpeechSessionEvent[] = []
    await broker.transcribeFile('/m/audio.m4a', (e) => events.push(e))
    expect(events.map((e) => e.type)).toEqual(['progress', 'final', 'progress', 'stopped'])
    expect(commands().find((c) => c.cmd === 'transcribe')).toMatchObject({ path: '/m/audio.m4a', locale: 'en-GB', contextualStrings: ['Atelier', 'Pip'] })
    expect(broker.status().active).toBeNull()
  })

  it('reports itself unavailable off macOS and Windows and when the helper is outdated', async () => {
    // Windows has its own helper (native/speech-win), so only Linux is unsupported.
    expect(setup([], { platform: 'win32' }).broker.status()).toEqual({ available: true, reason: null, active: null })
    const off = setup([], { platform: 'linux' })
    expect(off.broker.status()).toEqual({ available: false, reason: 'unsupported-platform', active: null })
    await expect(off.broker.begin({ purpose: 'dictation', mode: 'dictation' })).rejects.toMatchObject({ code: 'unsupported-platform' })
    expect(await off.broker.devices()).toEqual([])
    expect(await off.broker.authenticate('x')).toBe('unavailable')

    const old = setup([{ on: 'hello', lines: [{ type: 'ready', version: 1 }] }])
    await expect(old.broker.begin({ purpose: 'dictation', mode: 'dictation' })).rejects.toMatchObject({ code: 'helper-outdated' })
    expect(old.broker.status()).toMatchObject({ available: false, reason: 'helper-outdated' })
    expect(old.statuses.at(-1)?.reason).toBe('helper-outdated')
  })

  it('reports permissions, and restarts an idle helper to see a new Screen Recording grant', async () => {
    let screen: 'granted' | 'denied' = 'denied'
    const spawn = createFakeSpeechHelper([{ on: 'permissions', lines: () => [{ type: 'permissions', microphone: 'granted', speech: 'granted', screen } as HelperLine] }])
    const { broker } = setup([], { spawn })
    const seen: string[] = []
    broker.onPermissions((p) => seen.push(p.screen))
    expect(await broker.permissions()).toMatchObject({ screen: 'denied' })
    const first = spawn.last()
    screen = 'granted'
    expect(await broker.permissions()).toMatchObject({ screen: 'granted' })
    expect(spawn.last()).not.toBe(first)
    expect(seen).toEqual(['denied', 'granted'])
  })

  it('answers a poll with the last report while a prompt is up', async () => {
    const { broker, commands } = setup([{ on: 'request', delayMs: 60, lines: [{ type: 'permissions', microphone: 'granted', speech: 'not-determined', screen: 'granted' }] }])
    await broker.permissions()
    const prompt = broker.request('microphone')
    await tick()
    expect(await broker.permissions()).toMatchObject({ microphone: 'granted', speech: 'granted' })
    expect(await prompt).toMatchObject({ speech: 'not-determined' })
    expect(commands().filter((c) => c.cmd === 'permissions')).toHaveLength(1)
  })

  it('authenticates, finds the frontmost app and activates it', async () => {
    const { broker, commands } = setup([{ on: 'frontmost', lines: [{ type: 'frontmost', pid: 77, bundleId: 'com.example' }] }])
    expect(await broker.authenticate('Show the password')).toBe('ok')
    expect(await broker.frontmost()).toEqual({ pid: 77 })
    broker.activate(77)
    await until(() => commands().some((c) => c.cmd === 'activate'))
    expect(commands().find((c) => c.cmd === 'authenticate')).toMatchObject({ reason: 'Show the password' })
  })

  it('passes every raw line to onLine (the lid pause reads lid lines there)', async () => {
    const { broker, link } = setup([{ on: 'devices', lines: [{ type: 'lid', closed: true }, { type: 'devices', items: [] }] }])
    const lines: string[] = []
    broker.onLine((l) => lines.push(l.type))
    await link.ensure()
    await broker.devices()
    expect(lines).toContain('lid')
  })
})

describe('recordings left behind', () => {
  it('asks the helper to put one back together and answers with its audio, or the reason it couldn’t', async () => {
    const { broker, commands } = setup([
      {
        on: 'recover',
        once: true,
        lines: (cmd) => (cmd.cmd === 'recover' ? [{ type: 'recovered', id: cmd.id, audio: { path: cmd.path, bytes: 4096 }, durationMs: 61_000 }] : []),
      },
      { on: 'recover', lines: (cmd) => (cmd.cmd === 'recover' ? [{ type: 'recovered', id: cmd.id, audio: null, durationMs: 0, error: 'Nothing was recorded.' }] : []) },
    ])
    await expect(broker.recoverRecording('/data/meetings/m1/audio.m4a')).resolves.toEqual({ audio: { path: '/data/meetings/m1/audio.m4a', bytes: 4096 }, durationMs: 61_000 })
    expect(commands().find((c) => c.cmd === 'recover')).toMatchObject({ cmd: 'recover', path: '/data/meetings/m1/audio.m4a' })
    await expect(broker.recoverRecording('/data/meetings/m2/audio.m4a')).resolves.toEqual({ audio: null, durationMs: 0, error: 'Nothing was recorded.' })
  })

  it('refuses where there is no helper', async () => {
    const { broker } = setup([], { platform: 'linux' })
    await expect(broker.recoverRecording('/x/audio.m4a')).rejects.toMatchObject({ code: 'unsupported-platform' })
  })
})

describe('Screen Recording, asked in context', () => {
  const NO_SCREEN: FakeLine = { on: 'permissions', lines: [{ type: 'permissions', microphone: 'granted', speech: 'granted', screen: 'denied' }] }
  // The helper that asked still can't see a grant (macOS reads it at launch).
  const ASKED: FakeLine = { on: 'request', lines: [{ type: 'permissions', microphone: 'granted', speech: 'granted', screen: 'denied' }] }
  const requests = (commands: HelperCommand[]): string[] => commands.flatMap((c) => (c.cmd === 'request' ? [c.what] : []))

  it('asks once, at the first meeting, then records the microphone only and warns', async () => {
    const prompt = screenPromptFile(null)
    const { broker, commands } = setup([NO_SCREEN, ASKED, { on: 'start', lines: [{ type: 'started', session: '$session', mode: 'meeting', onDevice: true, systemAudio: false, deviceId: 'builtin', locale: 'en-GB', fallbackDevice: false }] }], { screenPrompt: prompt })
    const first = await broker.begin({ purpose: 'meeting', mode: 'meeting' })
    const events = collect(first)
    await until(() => events.some((e) => e.type === 'warning'))
    expect(events).toContainEqual({ type: 'warning', code: 'screen-missing' })
    expect(requests(commands())).toEqual(['screen'])
    expect(prompt.asked()).toBe(true)
    await first.stop()
    // Asked already: the next meeting (on a fresh helper) doesn't ask again; macOS wouldn't show its prompt anyway.
    await (await broker.begin({ purpose: 'meeting', mode: 'meeting' })).stop()
    expect(commands().filter((c) => c.cmd === 'start')).toHaveLength(1)
    expect(requests(commands())).toEqual([])
  })

  it('never asks for dictation, and a request from anywhere counts as asked', async () => {
    const prompt = screenPromptFile(null)
    const { broker, commands } = setup([NO_SCREEN], { screenPrompt: prompt })
    await (await broker.begin({ purpose: 'dictation', mode: 'dictation' })).stop()
    expect(requests(commands())).toEqual([])
    expect(prompt.asked()).toBe(false)
    await broker.request('screen')
    expect(prompt.asked()).toBe(true)
  })

  it('starts a meeting on a fresh helper when the last one saw Screen Recording off, so a new grant counts', async () => {
    let screen: 'granted' | 'denied' = 'denied'
    const spawn = createFakeSpeechHelper([{ on: 'permissions', lines: () => [{ type: 'permissions', microphone: 'granted', speech: 'granted', screen } as HelperLine] }, DEVICES, LOCALES])
    const prompt = screenPromptFile(null)
    prompt.markAsked()
    const { broker } = setup([], { spawn, screenPrompt: prompt })
    await (await broker.begin({ purpose: 'dictation', mode: 'dictation' })).stop()
    const before = spawn.last()
    screen = 'granted'
    await (await broker.begin({ purpose: 'meeting', mode: 'meeting' })).stop()
    expect(spawn.last()).not.toBe(before)
  })

  it('reads never asked, refused, and allowed but waiting for a relaunch', () => {
    const at = (o: Partial<Parameters<typeof screenAccessFrom>[0]>) => screenAccessFrom({ platform: 'darwin', main: false, helper: 'denied', asked: false, ...o })
    expect(at({})).toBe('not-determined')
    expect(at({ asked: true })).toBe('denied')
    expect(at({ helper: 'granted', asked: true })).toBe('relaunch')
    expect(at({ main: true })).toBe('granted')
    expect(at({ helper: null })).toBe('not-determined')
    expect(at({ platform: 'win32' })).toBe('unsupported')
  })

  it('asks through the helper without opening anything, and keeps the answer across launches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-screen-'))
    const file = join(dir, 'speech', 'screen-access.json')
    let main = false
    let helper: 'granted' | 'denied' = 'denied'
    const asked: string[] = []
    let relaunched = 0
    const host = createScreenAccess({
      platform: 'darwin',
      mainGranted: () => main,
      helperScreen: async () => helper,
      requestScreen: async () => {
        asked.push('screen')
        return helper
      },
      prompt: screenPromptFile(file),
      relaunch: () => relaunched++,
    })
    expect(await host.status()).toBe('not-determined')
    expect(await host.request()).toBe('denied')
    expect(asked).toEqual(['screen'])
    // Another launch reads the file: asked before, so it is denied, not never asked.
    expect(screenPromptFile(file).asked()).toBe(true)
    helper = 'granted'
    expect(await host.status()).toBe('relaunch')
    host.relaunch()
    expect(relaunched).toBe(1)
    main = true
    expect(await host.status()).toBe('granted')
    // Granted already: asking again sends nothing.
    expect(await host.request()).toBe('granted')
    expect(asked).toEqual(['screen'])
    host.forgetAsked()
    expect(screenPromptFile(file).asked()).toBe(false)
  })
})

describe('createMicTest', () => {
  it('records without transcribing, keeps the last test and deletes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-mictest-'))
    const spawn = createFakeSpeechHelper([
      DEVICES,
      LOCALES,
      {
        on: 'stop',
        lines: (_cmd, session) => {
          const start = spawn.last()?.commands.find((c): c is Extract<HelperCommand, { cmd: 'start' }> => c.cmd === 'start')
          const path = start?.record?.path ?? ''
          writeFileSync(path, 'audio')
          return [{ type: 'stopped', session, durationMs: 3100, audio: { path, bytes: 5 } }]
        },
      },
    ])
    const { broker } = setup([], { spawn })
    const test = createMicTest({ broker, dir, systemAudio: async () => true })
    expect(test.info()).toEqual({ exists: false, durationMs: 0, url: null })
    await test.start()
    const start = spawn.last()?.commands.find((c) => c.cmd === 'start')
    expect(start).toMatchObject({ mode: 'meeting', transcribe: false, levels: true, record: { path: join(dir, 'test.recording.m4a') } })
    await expect(test.start()).rejects.toMatchObject({ code: 'busy' })
    expect(await test.stop()).toEqual({ durationMs: 3100 })
    expect(test.info()).toEqual({ exists: true, durationMs: 3100, url: 'atelier-media://speech/test' })
    expect(existsSync(join(dir, 'test.m4a'))).toBe(true)
    test.remove()
    expect(test.info().exists).toBe(false)
  })

  it('records the microphone only without Screen Recording, and fails cleanly without audio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-mictest-'))
    const { broker, lastStart } = setup()
    const test = createMicTest({ broker, dir, systemAudio: async () => false })
    await test.start()
    expect(lastStart()?.mode).toBe('dictation')
    await expect(test.stop()).rejects.toMatchObject({ code: 'recording-failed' })
    expect(test.running()).toBeNull()
  })
})
