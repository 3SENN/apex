/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure pieces of the speech kit: meter scaling, the sensitivity slider's
// scale, the setup checklist's steps and the language and microphone lists.
import {
  SENSITIVITY,
  VOCABULARY_MAX,
  VOCABULARY_TERMS_MAX,
  VOCABULARY_TERM_MAX,
  clampSensitivity,
  normalizeLocaleId,
  parseVocabulary,
  resolveLocale,
  type AudioInputDevice,
  type MicChoice,
  type PermissionKind,
  type SpeechAssets,
  type SpeechLocale,
  type SpeechPermissions,
} from '@shared/speech'

/** The meter's floor: quieter than this draws as empty. */
export const METER_FLOOR_DB = -60

/** A level (RMS or peak, 0 to 1) as the meter's fill, on a decibel scale so speech fills most of it. */
export function levelToFraction(level: number): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  const db = 20 * Math.log10(Math.min(1, level))
  return Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / -METER_FLOOR_DB))
}

// The slider is logarithmic: the middle is 1×, each end a factor of four away.
const LOG_MIN = Math.log2(SENSITIVITY.min)
const LOG_MAX = Math.log2(SENSITIVITY.max)
export const SLIDER_STEPS = 40

/** Slider position (0 to SLIDER_STEPS) for a sensitivity. */
export function gainToSlider(gain: number): number {
  const log = Math.log2(clampSensitivity(gain))
  return Math.round(((log - LOG_MIN) / (LOG_MAX - LOG_MIN)) * SLIDER_STEPS)
}

/** Sensitivity for a slider position, rounded to two decimals. */
export function sliderToGain(position: number): number {
  const p = Math.max(0, Math.min(SLIDER_STEPS, position)) / SLIDER_STEPS
  return clampSensitivity(Math.round(2 ** (LOG_MIN + p * (LOG_MAX - LOG_MIN)) * 100) / 100)
}

export function formatGain(gain: number): string {
  const g = clampSensitivity(gain)
  return g >= 1 ? g.toFixed(1).replace(/\.0$/, '') : g.toFixed(2).replace(/0$/, '')
}

export type StepState = 'done' | 'ask' | 'denied' | 'restricted'

export interface ChecklistStep {
  kind: PermissionKind
  state: StepState
}

export const CHECKLIST_ORDER: readonly PermissionKind[] = ['microphone', 'speech', 'screen']

/**
 * The checklist's steps (ST-17). Allow asks the OS the first time; once it
 * was refused, the step opens the right Privacy pane instead. Screen
 * Recording can't tell "never asked" from "refused", so it asks once (the
 * OS prompts only the first time) and opens the pane after that.
 */
export function checklistSteps(p: SpeechPermissions, screenAsked: boolean): ChecklistStep[] {
  return CHECKLIST_ORDER.map((kind) => {
    if (kind === 'screen') return { kind, state: p.screen === 'granted' ? 'done' : screenAsked ? 'denied' : 'ask' }
    const value = p[kind]
    return { kind, state: value === 'granted' ? 'done' : value === 'not-determined' ? 'ask' : value === 'restricted' ? 'restricted' : 'denied' }
  })
}

/** The step to show open: the first one not done. */
export function currentStep(steps: readonly ChecklistStep[]): ChecklistStep | null {
  return steps.find((s) => s.state !== 'done') ?? null
}

/** Whether the checklist shows: hidden once all are done, or once dismissed with the essential two done. */
export function showChecklist(p: SpeechPermissions | null, dismissed: boolean): boolean {
  if (!p) return false
  const essentials = p.microphone === 'granted' && p.speech === 'granted'
  if (essentials && p.screen === 'granted') return false
  return !(dismissed && essentials)
}

/** Languages split for the select: on-device first, then those that use Apple's servers, each by name. */
export function groupLocales(items: readonly SpeechLocale[]): { onDevice: SpeechLocale[]; server: SpeechLocale[] } {
  const byName = (a: SpeechLocale, b: SpeechLocale): number => a.name.localeCompare(b.name)
  return { onDevice: items.filter((l) => l.onDevice).sort(byName), server: items.filter((l) => !l.onDevice).sort(byName) }
}

/** The language recognition will use for a setting (null: the system language). */
export function effectiveLocale(setting: string | null, list: { system: string; items: readonly SpeechLocale[] }): SpeechLocale | null {
  return resolveLocale(setting, list)
}

export interface MicOption {
  value: MicChoice
  /** A device name, or null for the two fixed choices. */
  name: string | null
  missing: boolean
}

/**
 * The microphone choices: built-in, the system default, then each other
 * input. A saved device that isn't connected stays listed, marked missing,
 * so the select still shows what was chosen.
 */
export function micOptions(devices: readonly AudioInputDevice[], saved: MicChoice, savedName: string | null = null): MicOption[] {
  const options: MicOption[] = [
    { value: 'built-in', name: null, missing: false },
    { value: 'system', name: null, missing: false },
  ]
  for (const device of devices) {
    if (device.builtIn) continue
    options.push({ value: `device:${device.id}`, name: device.name, missing: false })
  }
  if (saved.startsWith('device:') && !options.some((o) => o.value === saved)) options.push({ value: saved, name: savedName, missing: true })
  return options
}

/** Whether the saved choice isn't connected now (ST-18's notice). */
export function micMissing(devices: readonly AudioInputDevice[], saved: MicChoice): boolean {
  if (saved === 'system') return false
  if (saved === 'built-in') return devices.length > 0 && !devices.some((d) => d.builtIn)
  return !devices.some((d) => `device:${d.id}` === saved)
}

/** m:ss for the test's length and the recording clock. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export interface VocabularyStats {
  /** Characters typed, against VOCABULARY_MAX. */
  chars: number
  /** Terms the recognizer will get, after trimming and deduping. */
  terms: number
  /** More distinct terms than the recognizer takes. */
  tooMany: boolean
  /** Some term is longer than VOCABULARY_TERM_MAX and is skipped. */
  tooLong: boolean
}

/** The vocabulary field's counter and warnings (ST-19), from the same parser main uses. */
export function vocabularyStats(text: string): VocabularyStats {
  const kept = parseVocabulary(text).length
  const distinct = new Set<string>()
  let tooLong = false
  for (const raw of text.slice(0, VOCABULARY_MAX).split(/[\n,]/)) {
    const term = raw.replace(/\s+/g, ' ').trim()
    if (!term) continue
    if (term.length > VOCABULARY_TERM_MAX) tooLong = true
    else distinct.add(term.toLocaleLowerCase())
  }
  return { chars: text.length, terms: kept, tooMany: distinct.size > VOCABULARY_TERMS_MAX, tooLong }
}

/** The privacy line under the language (ST-18): on-device languages stay on this Mac, the rest go to Apple. */
export function localePrivacy(locale: SpeechLocale | null): 'on-device' | 'server' | null {
  if (!locale) return null
  return locale.onDevice ? 'on-device' : 'server'
}

// ── B:transcription engine ──

/** What Settings › Transcription says about the language's on-device model. */
export type ModelNotice = { kind: 'preparing'; percent: number | null } | { kind: 'ready' } | { kind: 'offer' } | { kind: 'failed' }

/**
 * The language's model for macOS 26's newer engine: preparing (with a
 * percentage once there is one), ready, an offer to prepare it now, or a
 * failure to retry. Nothing when this Mac or this language doesn't use it.
 */
export function modelNotice(assets: SpeechAssets | null): ModelNotice | null {
  if (!assets) return null
  switch (assets.state) {
    case 'downloading': {
      const f = assets.fraction
      return { kind: 'preparing', percent: f === null || !Number.isFinite(f) || f <= 0 ? null : Math.min(99, Math.max(1, Math.floor(f * 100))) }
    }
    case 'installed':
      return { kind: 'ready' }
    case 'supported':
      return { kind: 'offer' }
    case 'failed':
      return { kind: 'failed' }
    default:
      return null
  }
}

/** Two locale ids name the same language (macOS mixes 'en_US' and 'en-US'). */
export function sameLocale(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normalizeLocaleId(a).toLowerCase() === normalizeLocaleId(b).toLowerCase()
}
