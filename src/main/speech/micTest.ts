/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SPEECH_TEST_URL, SpeechError, type SpeechBroker, type SpeechSession } from '@shared/speech'

// The microphone test on Settings › Transcription (ST-21): it records
// without transcribing, with live levels, so you can hear what a meeting
// recording would sound like at the current sensitivities. Only the last test
// is kept, in userData/speech/test.m4a, which atelier-media://speech/test plays.

export interface MicTestDeps {
  broker: SpeechBroker
  /** userData/speech */
  dir: string
  /** A test stops by itself after this long. */
  maxMs?: number
  /** Whether system audio can be captured too (Screen Recording allowed). */
  systemAudio(): Promise<boolean>
}

export interface MicTest {
  start(): Promise<SpeechSession>
  stop(): Promise<{ durationMs: number }>
  info(): { exists: boolean; durationMs: number; url: typeof SPEECH_TEST_URL | null }
  remove(): void
  /** The running test's session id, if any. */
  running(): string | null
  dispose(): void
}

export const TEST_FILE = 'test.m4a'
const RECORDING_FILE = 'test.recording.m4a'
const META_FILE = 'test.json'

export function createMicTest(deps: MicTestDeps): MicTest {
  const maxMs = deps.maxMs ?? 30_000
  const file = join(deps.dir, TEST_FILE)
  const recording = join(deps.dir, RECORDING_FILE)
  const meta = join(deps.dir, META_FILE)
  let session: SpeechSession | null = null
  let stopping: Promise<{ durationMs: number }> | null = null
  let timer: NodeJS.Timeout | null = null

  // A test cut short by a quit or crash leaves a half-written file behind.
  rmSync(recording, { force: true })

  function readDuration(): number {
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8')) as { durationMs?: unknown }
      return typeof parsed.durationMs === 'number' && Number.isFinite(parsed.durationMs) ? Math.max(0, parsed.durationMs) : 0
    } catch {
      return 0
    }
  }

  async function stop(): Promise<{ durationMs: number }> {
    if (stopping) return stopping
    const current = session
    if (!current) throw new SpeechError('invalid', 'No microphone test is running.')
    if (timer) clearTimeout(timer)
    timer = null
    stopping = (async () => {
      try {
        const result = await current.stop()
        if (!result.audio || !existsSync(result.audio.path)) {
          rmSync(recording, { force: true })
          throw new SpeechError('recording-failed', 'The test recording could not be saved.')
        }
        renameSync(result.audio.path, file)
        writeFileSync(meta, JSON.stringify({ durationMs: result.durationMs }))
        return { durationMs: result.durationMs }
      } finally {
        session = null
        stopping = null
      }
    })()
    return stopping
  }

  return {
    async start() {
      if (session) throw new SpeechError('busy', 'A microphone test is already running.', 'level-test')
      mkdirSync(deps.dir, { recursive: true })
      rmSync(recording, { force: true })
      const both = await deps.systemAudio().catch(() => false)
      const next = await deps.broker.begin({ purpose: 'level-test', mode: both ? 'meeting' : 'dictation', record: recording, transcribe: false, levels: true })
      session = next
      // A test that loses the helper ends without a file.
      next.on((e) => {
        if (e.type === 'error' && e.fatal && session === next) {
          session = null
          if (timer) clearTimeout(timer)
          timer = null
        }
      })
      timer = setTimeout(() => void stop().catch(() => undefined), maxMs)
      timer.unref?.()
      return next
    },
    stop,
    info() {
      const exists = existsSync(file)
      return { exists, durationMs: exists ? readDuration() : 0, url: exists ? SPEECH_TEST_URL : null }
    },
    remove() {
      rmSync(file, { force: true })
      rmSync(meta, { force: true })
    },
    running: () => session?.id ?? null,
    dispose() {
      if (timer) clearTimeout(timer)
      session?.cancel()
      session = null
    },
  }
}
