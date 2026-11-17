/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { Settings } from '@shared/ipc'
import type { AutofillSettings } from '@shared/autofill'
import { DESKTOP_CALL_APP_IDS, type DesktopCallAppId } from '@shared/desktopCalls'
import { MUTED_SITES_MAX, type MeetingCardSettings } from '@shared/meetingCapture'
import { SENSITIVITY, VOCABULARY_MAX, type TranscriptionSettings } from '@shared/speech'
import { READ_ALOUD_MODIFIERS, VOICE_CHORDS, effectiveReadAloudModifier, type VoiceSettings } from '@shared/voice'

// The nested settings groups (voice, transcription, autofill, meeting cards)
// and the rules settings.ts uses for them: each nested group falls back field by field (one bad value keeps
// the rest of the group), a patch merges one level deep, and a few
// cross-field rules hold after every load and patch.

export const NESTED_SETTINGS_GROUPS = ['voice', 'transcription', 'autofill', 'meetingCards'] as const
export type NestedSettingsGroup = (typeof NESTED_SETTINGS_GROUPS)[number]

const VOICE_DEFAULTS: VoiceSettings = {
  holdToTalk: false,
  chord: 'alt+space',
  sounds: true,
  launcher: false,
  screenshot: true,
  screenshotSource: 'tab',
  readAloudModifier: 'shift',
  voiceName: null,
  target: 'auto',
  rewriteField: false,
  launcherScreenshot: true,
}

const TRANSCRIPTION_DEFAULTS: TranscriptionSettings = {
  mic: 'built-in',
  locale: null,
  // Meetings listen in one language unless you pick a second (Automatic or a language).
  secondaryLocale: 'none',
  vocabulary: '',
  autoSummarize: true,
  alertCalendar: true,
  alertMeetingSites: true,
  micSensitivity: 1,
  systemSensitivity: 1,
  recordAudio: true,
  recordOnly: false,
  setupDismissed: false,
  alertDesktopCalls: true,
  desktopCallsMuted: [],
}

const AUTOFILL_DEFAULTS: AutofillSettings = {
  offerLogins: true,
  offerSave: true,
  offerGenerated: true,
  addresses: true,
  addressAuth: true,
  cards: true,
  cardAuth: true,
  importHintDismissed: false,
  passwordsImported: false,
  yieldToPasswordExtension: true,
}

const MEETING_CARD_DEFAULTS: MeetingCardSettings = { all: false, kinds: [], sites: [] }

export const NESTED_SETTINGS_DEFAULTS: Pick<Settings, NestedSettingsGroup> = {
  voice: VOICE_DEFAULTS,
  transcription: TRANSCRIPTION_DEFAULTS,
  autofill: AUTOFILL_DEFAULTS,
  meetingCards: MEETING_CARD_DEFAULTS,
}

const locale = z.string().regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/)
// Out-of-range sensitivities are clamped by normalizeNestedSettings rather than dropped.
const sensitivity = z.number().finite()
const host = z.string().trim().min(1).max(253)

const voiceSchema = z
  .object({
    holdToTalk: z.boolean(),
    chord: z.enum(VOICE_CHORDS),
    sounds: z.boolean(),
    launcher: z.boolean(),
    screenshot: z.boolean(),
    screenshotSource: z.enum(['tab', 'screen']),
    readAloudModifier: z.enum(READ_ALOUD_MODIFIERS),
    voiceName: z.string().trim().min(1).max(200).nullable(),
    target: z.enum(['auto', 'companion', 'field']),
    rewriteField: z.boolean(),
    launcherScreenshot: z.boolean(),
  })
  .strict()

const transcriptionSchema = z
  .object({
    mic: z.union([z.enum(['built-in', 'system']), z.string().regex(/^device:[^\0]{1,256}$/)]) as z.ZodType<TranscriptionSettings['mic']>,
    locale: locale.nullable(),
    // null: Automatic (the Mac's next language); 'none': meetings listen in one language.
    secondaryLocale: z.union([locale, z.literal('none')]).nullable(),
    // Longer text is trimmed to the limit on load, not dropped (normalizeNestedSettings).
    vocabulary: z.string().max(VOCABULARY_MAX * 4),
    autoSummarize: z.boolean(),
    alertCalendar: z.boolean(),
    alertMeetingSites: z.boolean(),
    micSensitivity: sensitivity,
    systemSensitivity: sensitivity,
    recordAudio: z.boolean(),
    recordOnly: z.boolean(),
    setupDismissed: z.boolean(),
    alertDesktopCalls: z.boolean(),
    desktopCallsMuted: z.array(z.enum(DESKTOP_CALL_APP_IDS as [DesktopCallAppId, ...DesktopCallAppId[]])).max(DESKTOP_CALL_APP_IDS.length * 4),
  })
  .strict()

const autofillSchema = z
  .object({
    offerLogins: z.boolean(),
    offerSave: z.boolean(),
    offerGenerated: z.boolean(),
    addresses: z.boolean(),
    addressAuth: z.boolean(),
    cards: z.boolean(),
    cardAuth: z.boolean(),
    importHintDismissed: z.boolean(),
    passwordsImported: z.boolean(),
    yieldToPasswordExtension: z.boolean(),
  })
  .strict()

const meetingCardsSchema = z
  .object({
    all: z.boolean(),
    kinds: z.array(z.enum(['site', 'calendar', 'permissions'])).max(3),
    sites: z.array(host).max(MUTED_SITES_MAX * 4),
  })
  .strict()

/** The nested groups' schemas, spread into settings.ts's settingsSchema. */
export const NESTED_SETTINGS_SCHEMAS = {
  voice: voiceSchema,
  transcription: transcriptionSchema,
  autofill: autofillSchema,
  meetingCards: meetingCardsSchema,
}

/** What a patch may carry for each nested group: any subset of its fields, merged one level deep. */
export const NESTED_SETTINGS_PATCH_SCHEMAS = {
  voice: voiceSchema.partial().strict().optional(),
  transcription: transcriptionSchema.partial().strict().optional(),
  autofill: autofillSchema.partial().strict().optional(),
  meetingCards: meetingCardsSchema.partial().strict().optional(),
}

export type NestedSettingsPatch = { [K in NestedSettingsGroup]?: Partial<Settings[K]> }

/** Whether a schema is a plain object group whose fields can fall back one by one. */
export function isObjectSchema(schema: z.ZodType): schema is z.ZodObject<z.ZodRawShape> {
  return schema instanceof z.ZodObject
}

/**
 * One nested group from disk: each valid field is kept and each invalid or
 * missing one falls back to its default on its own.
 */
export function migrateNestedGroup<T extends object>(defaults: T, schema: z.ZodObject<z.ZodRawShape>, raw: unknown): T {
  const out = structuredClone(defaults)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const fields = raw as Record<string, unknown>
  for (const [key, field] of Object.entries(schema.shape)) {
    if (!Object.hasOwn(fields, key)) continue
    const parsed = (field as z.ZodType).safeParse(fields[key])
    if (parsed.success) Object.assign(out, { [key]: parsed.data })
  }
  return out
}

/** Merges each nested group of a patch one level deep into the current settings. */
export function mergeNestedSettingsPatch(current: Settings, patch: NestedSettingsPatch): Pick<Settings, NestedSettingsGroup> {
  return {
    voice: { ...current.voice, ...patch.voice },
    transcription: { ...current.transcription, ...patch.transcription },
    autofill: { ...current.autofill, ...patch.autofill },
    meetingCards: { ...current.meetingCards, ...patch.meetingCards },
  }
}

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * The cross-field rules: the read-aloud modifier is never one of the
 * chord's modifiers; the vocabulary is trimmed to its limit; sensitivities
 * stay in 0.25–4; muted sites are lowercase hosts, deduped, at most 200.
 */
export function normalizeNestedSettings<T extends Pick<Settings, NestedSettingsGroup>>(settings: T): T {
  const voice = { ...settings.voice, readAloudModifier: effectiveReadAloudModifier(settings.voice.chord, settings.voice.readAloudModifier) }
  const transcription = {
    ...settings.transcription,
    vocabulary: settings.transcription.vocabulary.slice(0, VOCABULARY_MAX),
    micSensitivity: clampNumber(settings.transcription.micSensitivity, SENSITIVITY.min, SENSITIVITY.max),
    systemSensitivity: clampNumber(settings.transcription.systemSensitivity, SENSITIVITY.min, SENSITIVITY.max),
    desktopCallsMuted: [...new Set(settings.transcription.desktopCallsMuted ?? [])],
  }
  const sites = [...new Set(settings.meetingCards.sites.map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, MUTED_SITES_MAX)
  const kinds = [...new Set(settings.meetingCards.kinds)]
  return { ...settings, voice, transcription, meetingCards: { ...settings.meetingCards, kinds, sites } }
}
