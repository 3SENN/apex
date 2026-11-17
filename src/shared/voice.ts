/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Voice commands: hold-to-talk, the voice HUD and the quick-ask
// launcher.

export type VoiceChord = 'alt+space' | 'ctrl+alt+space' | 'ctrl+shift+space'
export const VOICE_CHORDS: readonly VoiceChord[] = ['alt+space', 'ctrl+alt+space', 'ctrl+shift+space']

export type ReadAloudModifier = 'shift' | 'ctrl' | 'cmd'
export const READ_ALOUD_MODIFIERS: readonly ReadAloudModifier[] = ['shift', 'ctrl', 'cmd']

export type VoiceTarget = 'auto' | 'companion' | 'field'

export interface VoiceSettings {
  holdToTalk: boolean
  chord: VoiceChord
  sounds: boolean
  /** The opt-in global launcher shortcut. */
  launcher: boolean
  screenshot: boolean
  screenshotSource: 'tab' | 'screen'
  /** Never one of the chord's own modifiers (see effectiveReadAloudModifier). */
  readAloudModifier: ReadAloudModifier
  voiceName: string | null
  target: VoiceTarget
  rewriteField: boolean
  launcherScreenshot: boolean
}

/** The modifiers a chord holds down. */
export function chordModifiers(chord: VoiceChord): ReadAloudModifier[] {
  return chord
    .split('+')
    .filter((part) => part !== 'space' && part !== 'alt')
    .filter((part): part is ReadAloudModifier => (READ_ALOUD_MODIFIERS as readonly string[]).includes(part))
}

/** The saved read-aloud modifier, or, when the chord already holds it, the first of ctrl, shift and cmd that the chord doesn't. */
export function effectiveReadAloudModifier(chord: VoiceChord, modifier: ReadAloudModifier): ReadAloudModifier {
  const held = chordModifiers(chord)
  if (!held.includes(modifier)) return modifier
  return (['ctrl', 'shift', 'cmd'] as const).find((m) => !held.includes(m)) ?? 'cmd'
}

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'answered' | 'speaking' | 'error'

export type VoiceErrorCode =
  | 'mic-blocked'
  | 'mic-busy'
  | 'no-speech'
  | 'recording-failed'
  | 'no-field'
  | 'insert-failed'
  | 'no-engine'
  | 'another-recording'
  | 'failed'

/** The voice HUD float's payload. */
export interface HudPayload {
  state: VoiceState
  target: 'field' | 'companion'
  settled: string
  live: string
  chatId: string | null
  /** The chat's companion; '' while it is the active one (the float follows that). */
  companionId: string
  answer: { markdown: string; citations: { title: string; url: string }[] } | null
  error: { code: VoiceErrorCode; text?: string } | null
  queued: number
  countdownMs: number | null
  readAloud: boolean
  /** Counts turns, so the HUD restarts its tones, speech and countdown ring per turn. */
  turn: number
  /** settings.voice.sounds: the HUD plays its own start, end and error tones. */
  sounds: boolean
  /** The chord, for the "hold to reply" hint. */
  chord: VoiceChord
  /** settings.voice.voiceName for read-aloud. */
  voiceName: string | null
  /** The screenshot was skipped: Screen Recording is off (or on, waiting for a relaunch), or the tab could not be captured. */
  notice: 'screen-missing' | 'screen-relaunch' | 'no-screenshot' | null
  /** The field turn's outcome: typed in, or rewritten with a quick model call. */
  inserted: 'typed' | 'rewritten' | null
  /** A previous answer is in the panel while this command waits behind it. */
  waiting: boolean
}

/** The quick-ask launcher float's payload. */
export interface LauncherPayload {
  state: 'listening' | 'transcribing' | 'typing' | 'sending' | 'working' | 'error'
  text: string
  partial: string
  /** A small JPEG data URL of the captured display, or null. */
  screenshot: string | null
  attachScreenshot: boolean
  error: VoiceErrorCode | null
  /** The screenshot could not be taken: Screen Recording is off (the chip offers to allow it). */
  screenshotBlocked: boolean
  /** It is on in System Settings but needs Atelier to restart (the chip offers Relaunch Atelier). */
  screenshotRelaunch: boolean
  chord: VoiceChord
  sounds: boolean
  /** Counts openings, so the launcher refocuses its input and replays its start tone. */
  turn: number
}

/** 'fix' runs the current error's own action: Privacy settings, Model and key, or the running meeting. */
export const HUD_ACTIONS = ['dismiss', 'open-chat', 'read-aloud', 'copy', 'cancel-queued', 'switch-target', 'hover-start', 'hover-end', 'fix'] as const
export type HudAction = (typeof HUD_ACTIONS)[number]

export interface VoiceStatus {
  enabled: boolean
  state: VoiceState
  /** Where the current turn goes, while one runs. */
  target: 'field' | 'companion' | null
  chatId: string | null
  queued: number
  launcherOpen: boolean
  speaking: boolean
}

export const IDLE_VOICE: VoiceStatus = { enabled: false, state: 'idle', target: null, chatId: null, queued: 0, launcherOpen: false, speaking: false }


export interface VoiceServices {
  voice: {
    status(): VoiceStatus
    launcherToggle(): void
    hudAction(action: HudAction): void
    /** Whether the launcher's global shortcut is registered (Settings › Voice). */
    shortcutStatus(): { registered: boolean; conflict: boolean }
  }
}

export type VoiceAppEvent =
  | { type: 'voice'; status: VoiceStatus }
  /** Sent to one window's chrome: open the side panel on this chat (a voice command went there). */
  | { type: 'voice-open-chat'; chatId: string }
  /** DS-68: quick ask's composer as a presence input: companions in every window react to it. */
  | { type: 'quick-ask-presence'; signal: QuickAskSignal; companionId: string | null }


/** The read-aloud modifiers a chord leaves free (Settings › Voice lists only these). */
export function freeReadAloudModifiers(chord: VoiceChord): ReadAloudModifier[] {
  const held = chordModifiers(chord)
  return READ_ALOUD_MODIFIERS.filter((m) => !held.includes(m))
}

/** An Electron accelerator for the chord, for the launcher's global shortcut and the shortcut sheet. */
export function chordAccelerator(chord: VoiceChord): string {
  switch (chord) {
    case 'alt+space':
      return 'Alt+Space'
    case 'ctrl+alt+space':
      return 'Control+Alt+Space'
    case 'ctrl+shift+space':
      return 'Control+Shift+Space'
  }
}

/** Float methods the voice floats call besides the voice service (FLOAT_METHODS regions). */
export const LAUNCHER_ACTIONS = ['launcher:submit', 'launcher:type', 'launcher:screenshot', 'launcher:dismiss', 'launcher:listen', 'launcher:fix'] as const
/** DS-68: the launcher's composer signals (typing, focus, send) relayed to the chrome's presence store. */
export const LAUNCHER_PRESENCE = 'launcher:presence'
export const QUICK_ASK_SIGNALS = ['typing', 'idle', 'sent'] as const
export type QuickAskSignal = (typeof QUICK_ASK_SIGNALS)[number]
export const HUD_SPEECH = 'hud:speech'
export type HudSpeechEvent = 'started' | 'boundary' | 'ended' | 'failed'
