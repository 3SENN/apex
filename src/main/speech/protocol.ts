/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { HELPER_ERROR_CODES, SPEECH_PROTOCOL_VERSION, type HelperCommand, type HelperLine } from '@shared/speech'

// apex-speech protocol v2: every line the helper prints is checked here
// before main acts on it. Unknown line types are ignored rather than failing,
// so the helper can add lines (such as `lid`) without a version bump. Extra
// fields are dropped for the same reason.

const source = z.enum(['mic', 'system'])
const perm = z.enum(['granted', 'denied', 'restricted', 'not-determined'])
const session = z.string().min(1).max(100)
const text = z.string().max(20_000)
const ms = z.number().finite().min(0)
// Levels and progress are clamped rather than rejected: a meter must never
// stop because a value rounded past 1.
const unit = z
  .number()
  .finite()
  .transform((n) => Math.min(1, Math.max(0, n)))
const path = z.string().min(1).max(4096)
const pid = z.number().int().positive()
const bundle = z.string().min(1).max(512)
// B:transcription engine: an engine or model state a newer helper adds reads as unknown, never as a dropped line.
const engine = z.enum(['analyzer', 'recognizer']).optional().catch(undefined)
const locale = z.string().min(1).max(64)

const lineSchema = z.discriminatedUnion('type', [
  // A v1 helper printed `ready` with no version.
  z.object({ type: z.literal('ready'), version: z.number().int().positive().default(1) }),
  z.object({ type: z.literal('permissions'), microphone: perm, speech: perm, screen: z.enum(['granted', 'denied']), location: perm.optional() }),
  z.object({
    type: z.literal('devices'),
    items: z.array(z.object({ id: z.string().min(1).max(512), name: z.string().max(512), builtIn: z.boolean(), isDefault: z.boolean() })).max(200),
  }),
  z.object({
    type: z.literal('locales'),
    system: z.string().min(1).max(64),
    items: z.array(z.object({ id: z.string().min(1).max(64), name: z.string().max(200), onDevice: z.boolean(), engine })).max(500),
  }),
  z.object({ type: z.literal('auth'), id: z.string().min(1).max(100), result: z.enum(['ok', 'cancelled', 'unavailable']) }),
  z.object({ type: z.literal('frontmost'), pid: z.number().int().positive().nullable(), bundleId: z.string().max(512).nullable() }),
  z.object({
    type: z.literal('started'),
    session,
    mode: z.enum(['dictation', 'meeting']),
    onDevice: z.boolean(),
    systemAudio: z.boolean(),
    deviceId: z.string().max(512).nullable(),
    locale: z.string().max(64),
    fallbackDevice: z.boolean(),
    engine,
    secondaryLocale: z.string().max(64).optional(),
  }),
  // Bilingual: the language a line was heard in; a final's fit (how well it reads as it) and confidence (how sure its recognizer was).
  z.object({ type: z.literal('partial'), session, source, text, startMs: ms, endMs: ms, locale: z.string().max(64).optional() }),
  z.object({ type: z.literal('final'), session, source, text, startMs: ms, endMs: ms, locale: z.string().max(64).optional(), fit: unit.optional(), confidence: unit.optional() }),
  z.object({ type: z.literal('level'), session, source, rms: unit, peak: unit }),
  z.object({ type: z.literal('paused'), session }),
  z.object({ type: z.literal('resumed'), session }),
  z.object({ type: z.literal('interrupted'), session, source }),
  z.object({ type: z.literal('restored'), session, source }),
  z.object({ type: z.literal('progress'), session, fraction: unit }),
  z.object({
    type: z.literal('error'),
    session: session.optional(),
    source: source.optional(),
    // An unknown code from a newer helper still reads as a plain failure.
    code: z.string().transform((c) => ((HELPER_ERROR_CODES as readonly string[]).includes(c) ? (c as (typeof HELPER_ERROR_CODES)[number]) : 'failed')),
    message: z.string().max(2000),
    fatal: z.boolean(),
  }),
  z.object({ type: z.literal('stopped'), session, durationMs: ms, audio: z.object({ path, bytes: z.number().int().min(0) }).nullable() }),
  z.object({ type: z.literal('lid'), closed: z.boolean() }),
  // A recording left in parts, put back together (`recover`, Recorder.swift).
  z.object({ type: z.literal('recovered'), id: z.string().min(1).max(200), audio: z.object({ path, bytes: z.number().int().min(0) }).nullable(), durationMs: ms, error: z.string().max(2000).optional() }),
  // B:transcription engine: a language model's state (Models.swift); a state this version doesn't know reads as unsupported.
  z.object({
    type: z.literal('assets'),
    locale,
    state: z.enum(['unavailable', 'unsupported', 'supported', 'downloading', 'installed', 'failed']).catch('unsupported'),
    fraction: unit.nullable().default(null),
  }),
  // Desktop calls (CallWatch.swift): a full snapshot each time something changes.
  z.object({
    type: z.literal('calls'),
    supported: z.boolean(),
    audio: z
      .array(
        z.object({
          pid: pid,
          bundleId: bundle.nullable(),
          exe: z.string().max(256).nullable(),
          appPid: pid.nullable(),
          appBundleId: bundle.nullable(),
          input: z.boolean(),
          output: z.boolean(),
        }),
      )
      .max(500),
    apps: z.array(z.object({ pid: pid, bundleId: bundle, name: z.string().max(512) })).max(500),
  }),
])

/** One helper line, or null when it isn't JSON or isn't a line this version knows. */
export function parseHelperLine(line: string): HelperLine | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = lineSchema.safeParse(raw)
  return parsed.success ? (parsed.data as HelperLine) : null
}

/** One command as the line the helper reads. */
export function encodeCommand(cmd: HelperCommand): string {
  return `${JSON.stringify(cmd)}\n`
}

/** Whether a helper that answered `hello` with `version` speaks this protocol. */
export function helperVersionOk(version: number): boolean {
  return version >= SPEECH_PROTOCOL_VERSION
}

/** The session a line belongs to, if any. */
export function lineSession(line: HelperLine): string | undefined {
  return 'session' in line ? line.session : undefined
}
