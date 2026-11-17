/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Always-on-top floating windows: the quick-ask launcher, the voice HUD,
// the meeting card and the recording widget. Each is a sandboxed panel with
// its own preload (src/preload/float.ts) and may call only the methods its
// kind lists in FLOAT_METHODS; main checks that the caller is that kind's own
// window. Each kind's methods sit in its own region.
import type { Companion } from './companion'
import type { AppLanguage } from './i18n/locales'
import type { ThemeState } from './theme'
import type { SpeechSource } from './speech'

export type FloatKind = 'launcher' | 'voice-hud' | 'meeting-card' | 'recording'
export const FLOAT_KINDS: readonly FloatKind[] = ['launcher', 'voice-hud', 'meeting-card', 'recording']

export const FLOAT = {
  invoke: 'float:invoke',
  /** main -> float */
  event: 'float:event',
  resize: 'float:resize',
  /** Synchronous: the preload reads its kind and initial state before the first render. */
  ready: 'float:ready',
  close: 'float:close',
} as const

export type FloatEvent =
  | { type: 'payload'; payload: unknown }
  | { type: 'theme'; theme: ThemeState }
  | { type: 'level'; source: SpeechSource; rms: number; peak: number }
  | { type: 'companion'; companion: Companion | null }
  | { type: 'language'; language: FloatLanguage }

/** The app language main speaks, so the floats (cards, the recording widget, the HUD) speak it too. */
export interface FloatLanguage {
  language: AppLanguage
  locale: string
  pseudo: boolean
}

export interface FloatInitial {
  theme: ThemeState
  payload: unknown
  companion: Companion | null
  /** Apex's own Reduce Motion setting (the system setting is read by the renderer). */
  reduceMotion: boolean
  language: FloatLanguage
}

/** What the float preload exposes as `window.apexFloat`. */
export interface ApexFloatApi {
  kind: FloatKind
  initial: FloatInitial
  /** process.platform: a float words things as the system does (no Mac on Windows). */
  platform: string
  invoke(method: string, ...args: unknown[]): Promise<unknown>
  onEvent(fn: (e: FloatEvent) => void): () => void
  requestSize(size: { width: number; height: number }): void
  close(): void
}

export type FloatAnchor = 'bottom-center' | 'bottom-right' | 'right-edge'
export type FloatDisplay = 'cursor' | 'apex'

export interface Placement {
  display?: FloatDisplay
  anchor?: FloatAnchor
  /** Distance from the work area's edges, in DIP. */
  margin?: number
  /** A remembered spot for the draggable widget: which edge and how far down (0..1). */
  remembered?: { displayId: number; edge: 'left' | 'right'; yFraction: number } | null
}

export interface FloatSpec {
  focusable: boolean
  movable: boolean
  width: number
  height: number
  /** The largest size requestSize may ask for. */
  max: { width: number; height: number }
  placement: Required<Pick<Placement, 'display' | 'anchor' | 'margin'>>
  /** Relative 'floating' level, so floats stack launcher > HUD > card > widget. */
  level: number
  /** Survives ⌘H (macOS canHide = NO); every kind but the launcher. */
  survivesHide: boolean
  /** Shown this long after open() (the meeting card waits about 3 s; smoke shortens it). */
  showDelayMs: number
}

export const FLOAT_SPECS: Record<FloatKind, FloatSpec> = {
  launcher: {
    focusable: true, movable: false, width: 560, height: 120, max: { width: 560, height: 420 },
    placement: { display: 'cursor', anchor: 'bottom-center', margin: 96 }, level: 3, survivesHide: false, showDelayMs: 0,
  },
  'voice-hud': {
    focusable: false, movable: false, width: 420, height: 140, max: { width: 420, height: 480 },
    placement: { display: 'apex', anchor: 'bottom-center', margin: 48 }, level: 2, survivesHide: true, showDelayMs: 0,
  },
  'meeting-card': {
    focusable: false, movable: false, width: 360, height: 150, max: { width: 360, height: 320 },
    placement: { display: 'cursor', anchor: 'bottom-right', margin: 16 }, level: 1, survivesHide: true, showDelayMs: 3000,
  },
  recording: {
    focusable: false, movable: true, width: 220, height: 48, max: { width: 360, height: 240 },
    placement: { display: 'cursor', anchor: 'right-edge', margin: 16 }, level: 0, survivesHide: true, showDelayMs: 0,
  },
}

/**
 * The only methods each kind may invoke. 'service.method' names go to the
 * feature services (validated by SERVICE_SCHEMAS); 'kind:action' names go to
 * handlers the owning feature registers with FloatManager.handle.
 */
export const FLOAT_METHODS: Record<FloatKind, readonly string[]> = {
  launcher: ['voice.status', 'voice.launcherToggle', 'launcher:submit', 'launcher:type', 'launcher:screenshot', 'launcher:dismiss', 'launcher:listen', 'launcher:fix', 'launcher:presence'],
  'voice-hud': ['voice.status', 'voice.hudAction', 'hud:speech'],
  'meeting-card': ['meetingCapture.status', 'card:action'],
  // The wrap-up's companion picker lists companions and starts the chat about the meeting (MV-11).
  recording: ['meetingCapture.status', 'meetingCapture.pause', 'meetingCapture.resume', 'meetingCapture.stop', 'wrapup:action', 'recording:moved', 'recording:fix-screen', 'recording:transcription-settings', 'companions.list', 'meetings.discuss'],
}

/** Whether `kind` may call `method`. */
export function floatMayCall(kind: FloatKind, method: string): boolean {
  return FLOAT_METHODS[kind].includes(method)
}
