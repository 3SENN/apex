/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HELPER_ERROR_CODES, SpeechError, decodeSpeechError, encodeSpeechError, samePermissions } from '../src/shared/speech'
import { encodeCommand, helperVersionOk, lineSession, parseHelperLine } from '../src/main/speech/protocol'
import { speechHelperPath } from '../src/main/speech/helper'
import type { HelperLine } from '../src/shared/speech'

// atelier-speech protocol v2: every line main reads goes through this parser.

describe('parseHelperLine', () => {
  it('reads every v2 line', () => {
    const lines = [
      { type: 'ready', version: 2 },
      { type: 'permissions', microphone: 'granted', speech: 'not-determined', screen: 'denied' },
      { type: 'devices', items: [{ id: 'BuiltInMicrophoneDevice', name: 'MacBook Pro Microphone', builtIn: true, isDefault: true }] },
      { type: 'locales', system: 'en-US', items: [{ id: 'en-US', name: 'English (United States)', onDevice: true }] },
      { type: 'auth', id: 'a1', result: 'cancelled' },
      { type: 'frontmost', pid: 42, bundleId: 'com.example.app' },
      { type: 'started', session: 's1', mode: 'meeting', onDevice: false, systemAudio: true, deviceId: null, locale: 'nl-NL', fallbackDevice: true },
      { type: 'partial', session: 's1', source: 'mic', text: 'hello', startMs: 0, endMs: 420 },
      { type: 'final', session: 's1', source: 'system', text: 'Hello there.', startMs: 100, endMs: 900 },
      { type: 'level', session: 's1', source: 'mic', rms: 0.2, peak: 0.6 },
      { type: 'paused', session: 's1' },
      { type: 'resumed', session: 's1' },
      { type: 'interrupted', session: 's1', source: 'system' },
      { type: 'restored', session: 's1', source: 'system' },
      { type: 'progress', session: 's1', fraction: 0.5 },
      { type: 'error', session: 's1', source: 'system', code: 'screen-denied', message: 'No screen access', fatal: false },
      { type: 'stopped', session: 's1', durationMs: 61_000, audio: { path: '/tmp/a.m4a', bytes: 1024 } },
      { type: 'lid', closed: true },
    ]
    for (const line of lines) expect(parseHelperLine(JSON.stringify(line)), line.type).toEqual(line)
  })

  it('reads Location Services in the permissions line, and an older helper without it', () => {
    const line = { type: 'permissions', microphone: 'granted', speech: 'granted', screen: 'granted', location: 'denied' }
    expect(parseHelperLine(JSON.stringify(line))).toEqual(line)
    expect(parseHelperLine(JSON.stringify({ ...line, location: undefined }))).toEqual({ type: 'permissions', microphone: 'granted', speech: 'granted', screen: 'granted' })
    expect(parseHelperLine(JSON.stringify({ ...line, location: 'maybe' }))).toBeNull()
    // A location change is a change: the chrome hears about it.
    const p = { microphone: 'granted', speech: 'granted', screen: 'granted' } as const
    expect(samePermissions({ ...p, location: 'granted' }, { ...p, location: 'denied' })).toBe(false)
    expect(samePermissions({ ...p, location: 'granted' }, { ...p, location: 'granted' })).toBe(true)
  })

  it('reads recovered exactly as the helper prints it (escaped slashes, null audio, an error)', () => {
    expect(parseHelperLine('{"type":"recovered","audio":{"path":"\\/tmp\\/m4\\/audio.m4a","bytes":119821},"durationMs":4948,"id":"r2"}')).toEqual({
      type: 'recovered',
      id: 'r2',
      audio: { path: '/tmp/m4/audio.m4a', bytes: 119821 },
      durationMs: 4948,
    })
    expect(parseHelperLine('{"audio":null,"type":"recovered","id":"r3","durationMs":0}')).toEqual({ type: 'recovered', id: 'r3', audio: null, durationMs: 0 })
    expect(parseHelperLine('{"type":"recovered","id":"r4","audio":null,"durationMs":0,"error":"Nothing was recorded."}')).toMatchObject({ error: 'Nothing was recorded.' })
  })

    it('reads a v1 ready as version 1, which is outdated', () => {
    expect(parseHelperLine('{"type":"ready"}')).toEqual({ type: 'ready', version: 1 })
    expect(helperVersionOk(1)).toBe(false)
    expect(helperVersionOk(2)).toBe(true)
  })

  it('ignores unknown lines, bad JSON and malformed known lines', () => {
    expect(parseHelperLine('{"type":"telemetry","x":1}')).toBeNull()
    expect(parseHelperLine('not json')).toBeNull()
    expect(parseHelperLine('')).toBeNull()
    expect(parseHelperLine('{"type":"final","session":"s","source":"speaker","text":"x","startMs":0,"endMs":1}')).toBeNull()
    expect(parseHelperLine('{"type":"partial","session":"s","source":"mic","text":"x"}')).toBeNull()
    // v1's error had no code or fatal flag.
    expect(parseHelperLine('{"type":"error","message":"Unknown command hello."}')).toBeNull()
  })

  it('drops extra fields and clamps levels and progress', () => {
    expect(parseHelperLine('{"type":"paused","session":"s","extra":true}')).toEqual({ type: 'paused', session: 's' })
    expect(parseHelperLine('{"type":"level","session":"s","source":"mic","rms":1.2,"peak":-0.1}')).toEqual({ type: 'level', session: 's', source: 'mic', rms: 1, peak: 0 })
    expect(parseHelperLine('{"type":"progress","session":"s","fraction":1.0001}')).toMatchObject({ fraction: 1 })
  })

  it('reads an unknown error code from a newer helper as failed', () => {
    expect(parseHelperLine('{"type":"error","code":"gpu-on-fire","message":"?","fatal":true}')).toMatchObject({ code: 'failed', fatal: true })
    for (const code of HELPER_ERROR_CODES) expect(parseHelperLine(JSON.stringify({ type: 'error', code, message: '', fatal: false }))).toMatchObject({ code })
  })

  it('names the session a line belongs to', () => {
    const final = parseHelperLine('{"type":"final","session":"s9","source":"mic","text":"x","startMs":0,"endMs":1}')
    expect(final && lineSession(final)).toBe('s9')
    const devices = parseHelperLine('{"type":"devices","items":[]}')
    expect(devices && lineSession(devices)).toBeUndefined()
  })
})

describe('encodeCommand', () => {
  it('writes one JSON object per line', () => {
    expect(encodeCommand({ cmd: 'hello' })).toBe('{"cmd":"hello"}\n')
    const start = encodeCommand({ cmd: 'start', session: 's', mode: 'dictation', locale: 'en-US', deviceId: null, contextualStrings: ['Atelier'], micGain: 1, systemGain: 2, transcribe: true, levels: false, record: null })
    expect(start.endsWith('\n')).toBe(true)
    expect(JSON.parse(start)).toMatchObject({ cmd: 'start', contextualStrings: ['Atelier'], systemGain: 2 })
  })
})

describe('SpeechError over IPC', () => {
  it('round-trips the code and holder through an error message', () => {
    const text = encodeSpeechError(new SpeechError('busy', 'Another recording is already running.', 'meeting'))
    expect(decodeSpeechError(`Error invoking remote method 'atelier:service': Error: ${text}`)).toEqual({ code: 'busy', holder: 'meeting', message: 'Another recording is already running.' })
    expect(decodeSpeechError(encodeSpeechError(new SpeechError('helper-outdated')))).toEqual({ code: 'helper-outdated', message: 'helper-outdated' })
    expect(decodeSpeechError('[speech:nonsense] x')).toBeNull()
    expect(decodeSpeechError('plain failure')).toBeNull()
  })
})

// Transcripts in each helper's own serialisation (tests/fixtures/speech):
// Swift's JSONSerialization prints keys in any order, System.Text.Json in
// declaration order, and each helper words its errors its own way. The same
// meeting from both must parse to the same events; only the Mac reports its lid.
function transcript(name: string): { raw: string; line: HelperLine | null }[] {
  return readFileSync(join(__dirname, 'fixtures', 'speech', name), 'utf8')
    .split('\n')
    .filter((raw) => raw.trim())
    .map((raw) => ({ raw, line: parseHelperLine(raw) }))
}

const lines = (name: string): HelperLine[] => transcript(name).map(({ line }) => line!)

/** A line without what is allowed to differ by platform: device ids, paths, the on-device flag and error wording. */
function portable(line: HelperLine): unknown {
  const copy: Record<string, unknown> = { ...line }
  if (line.type === 'started') {
    copy.deviceId = line.deviceId === null ? null : 'device'
    delete copy.onDevice
  }
  if (line.type === 'stopped' && line.audio) copy.audio = { path: 'file', bytes: line.audio.bytes }
  if (line.type === 'error') delete copy.message
  return copy
}

describe('helper protocol parity (macOS and Windows)', () => {
  it.each(['mac-handshake.jsonl', 'mac-meeting.jsonl', 'win-handshake.jsonl', 'win-meeting.jsonl'])('parses every line of %s', (name) => {
    const unread = transcript(name).filter(({ line }) => line === null).map(({ raw }) => raw)
    expect(unread).toEqual([])
  })

  it('reads the same meeting from both helpers, apart from the Mac lid lines', () => {
    const mac = lines('mac-meeting.jsonl')
    const win = lines('win-meeting.jsonl')
    const lid = mac.filter((l) => l.type === 'lid')
    expect(lid).toEqual([{ type: 'lid', closed: true }, { type: 'lid', closed: false }])
    expect(mac.filter((l) => l.type !== 'lid').map(portable)).toEqual(win.map(portable))
  })

  it('pauses and resumes the same way, inside one session', () => {
    for (const name of ['mac-meeting.jsonl', 'win-meeting.jsonl']) {
      const flow = lines(name).filter((l) => ['started', 'paused', 'resumed', 'stopped'].includes(l.type))
      expect(flow.map((l) => l.type)).toEqual(['started', 'paused', 'resumed', 'stopped'])
      expect(new Set(flow.map(lineSession))).toEqual(new Set(['m1']))
    }
  })

  it('answers the handshake with the same kinds of line', () => {
    const kinds = (name: string): string[] => lines(name).map((l) => l.type)
    expect(kinds('win-handshake.jsonl')).toEqual(kinds('mac-handshake.jsonl'))
    const ready = lines('win-handshake.jsonl')[0]
    expect(ready?.type === 'ready' && helperVersionOk(ready.version)).toBe(true)
    // Windows dictation runs on Microsoft's online service, so no locale is on-device.
    const locales = lines('win-handshake.jsonl').find((l) => l.type === 'locales')
    expect(locales?.type === 'locales' && locales.items.every((i) => !i.onDevice)).toBe(true)
  })

  it('reads the lid line strictly', () => {
    expect(parseHelperLine('{"type":"lid","closed":true}')).toEqual({ type: 'lid', closed: true })
    expect(parseHelperLine('{"closed":false,"type":"lid","extra":1}')).toEqual({ type: 'lid', closed: false })
    expect(parseHelperLine('{"type":"lid"}')).toBeNull()
    expect(parseHelperLine('{"type":"lid","closed":"yes"}')).toBeNull()
  })
})

describe('speechHelperPath on Windows', () => {
  it('runs atelier-speech.exe from Resources when packaged and from the build folder in development', () => {
    expect(speechHelperPath({ platform: 'win32', packaged: true, resourcesPath: 'R', appPath: 'A' })).toBe(join('R', 'atelier-speech.exe'))
    expect(speechHelperPath({ platform: 'win32', packaged: false, resourcesPath: 'R', appPath: 'A' })).toBe(join('A', 'native', 'speech-win', 'build', 'atelier-speech.exe'))
    expect(speechHelperPath({ platform: 'linux', packaged: true, resourcesPath: 'R', appPath: 'A' })).toBeNull()
  })
})
