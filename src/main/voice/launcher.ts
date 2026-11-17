/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LauncherPayload, VoiceChord, VoiceErrorCode } from '@shared/voice'

// The quick-ask launcher's state machine (MV-02, MV-03): listening, then
// transcribing, then the text to edit (typing), sending and working, or an
// error. Pure; main keeps the screenshot itself and feeds this events.

export type LauncherEvent =
  | { type: 'open'; attach: boolean; screenshot: string | null; screenshotBlocked: boolean; chord: VoiceChord; sounds: boolean }
  | { type: 'shot'; screenshot: string | null; blocked: boolean; relaunch?: boolean; attach: boolean }
  | { type: 'listen' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'stop' }
  | { type: 'stopped' }
  | { type: 'type' }
  | { type: 'edit'; text: string }
  | { type: 'attach'; on: boolean }
  | { type: 'send' }
  | { type: 'sent' }
  | { type: 'error'; code: VoiceErrorCode }

export function closedLauncher(): LauncherPayload {
  return { state: 'listening', text: '', partial: '', screenshot: null, attachScreenshot: false, error: null, screenshotBlocked: false, screenshotRelaunch: false, chord: 'alt+space', sounds: true, turn: 0 }
}

function joined(text: string, more: string): string {
  return [text.trim(), more.trim()].filter(Boolean).join(' ')
}

export function reduceLauncher(p: LauncherPayload, e: LauncherEvent): LauncherPayload {
  switch (e.type) {
    case 'open':
      return {
        state: 'listening',
        text: '',
        partial: '',
        screenshot: e.screenshot,
        attachScreenshot: e.attach && e.screenshot !== null,
        error: null,
        screenshotBlocked: e.screenshotBlocked,
        screenshotRelaunch: false,
        chord: e.chord,
        sounds: e.sounds,
        turn: p.turn + 1,
      }
    case 'shot':
      // The capture lands after the launcher is already listening.
      return { ...p, screenshot: e.screenshot, screenshotBlocked: e.blocked, screenshotRelaunch: e.blocked && e.relaunch === true, attachScreenshot: e.attach && e.screenshot !== null }
    case 'listen':
      // Listening again adds to what is already there.
      return p.state === 'sending' || p.state === 'working' ? p : { ...p, state: 'listening', partial: '', error: null }
    case 'partial':
      return p.state === 'listening' || p.state === 'transcribing' ? { ...p, partial: e.text } : p
    case 'final':
      return p.state === 'listening' || p.state === 'transcribing' ? { ...p, text: joined(p.text, e.text), partial: '' } : p
    case 'stop':
      return p.state === 'listening' ? { ...p, state: 'transcribing' } : p
    case 'stopped':
      if (p.state !== 'listening' && p.state !== 'transcribing') return p
      // A partial the recogniser never finalised still counts.
      return { ...p, state: 'typing', text: joined(p.text, p.partial), partial: '' }
    case 'type':
      return p.state === 'sending' || p.state === 'working' ? p : { ...p, state: 'typing', text: joined(p.text, p.partial), partial: '', error: null }
    case 'edit':
      return p.state === 'typing' || p.state === 'error' ? { ...p, state: 'typing', text: e.text, error: null } : p
    case 'attach':
      return { ...p, attachScreenshot: e.on && p.screenshot !== null }
    case 'send':
      return p.text.trim() && (p.state === 'typing' || p.state === 'listening' || p.state === 'transcribing') ? { ...p, state: 'sending' } : p
    case 'sent':
      return p.state === 'sending' ? { ...p, state: 'working' } : p
    case 'error':
      return { ...p, state: 'error', error: e.code, partial: '' }
  }
}

/** What the launcher key does: while listening it stops and shows the text; at any other time it hides. */
export function launcherKeyAction(open: boolean, p: LauncherPayload): 'open' | 'stop' | 'hide' {
  if (!open) return 'open'
  return p.state === 'listening' ? 'stop' : 'hide'
}
