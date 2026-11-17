/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// "Leave this page?": Electron cancels an unload the page wants to
// keep unless main says otherwise synchronously, so Apex lets it cancel,
// asks with its own dialog, then redoes what you were doing with a one-shot
// skip. What you were doing is the newest recorded intent: Apex's own
// navigations, reloads, history moves and closes, and the page's own
// navigations as its preload reports them. Pure, so tested.

export type LeaveIntent =
  | { kind: 'load'; url: string; at: number }
  | { kind: 'reload'; ignoreCache: boolean; at: number }
  | { kind: 'history'; offset: number; at: number }
  | { kind: 'index'; index: number; at: number }
  | { kind: 'close'; at: number }
  | { kind: 'page'; url: string; form: boolean; at: number }

/** An intent older than this didn't cause the prompt. */
export const INTENT_MAX_AGE_MS = 5000
/** After you choose Leave, the next unload goes through without asking, if it comes within this. */
export const SKIP_WINDOW_MS = 10_000

export interface LeaveState {
  intent: LeaveIntent | null
  skipUntil: number
}

export function newLeaveState(): LeaveState {
  return { intent: null, skipUntil: 0 }
}

export function record(state: LeaveState, intent: LeaveIntent): void {
  state.intent = intent
}

/** The intent that triggered the prompt, if it is recent enough. */
export function pickIntent(state: LeaveState, now: number): LeaveIntent | null {
  const intent = state.intent
  return intent && now - intent.at <= INTENT_MAX_AGE_MS ? intent : null
}

/** Whether this unload is the redo of one you already allowed (and spends the skip). */
export function consumeSkip(state: LeaveState, now: number): boolean {
  if (state.skipUntil === 0 || state.skipUntil < now) return false
  state.skipUntil = 0
  return true
}

export function allowNext(state: LeaveState, now: number): void {
  state.skipUntil = now + SKIP_WINDOW_MS
}

/** What redo does: replay the intent, or (a form post, or nothing known) let you do it again yourself. */
export type RedoPlan = { kind: 'replay'; intent: Exclude<LeaveIntent, { kind: 'page'; form: true }> } | { kind: 'again'; reason: 'form' | 'unknown' }

export function redoPlan(intent: LeaveIntent | null): RedoPlan {
  if (!intent) return { kind: 'again', reason: 'unknown' }
  // A form post can't be replayed without its body.
  if (intent.kind === 'page' && intent.form) return { kind: 'again', reason: 'form' }
  return { kind: 'replay', intent: intent as Exclude<LeaveIntent, { kind: 'page'; form: true }> }
}

/** Reload prompts read differently from leave prompts. */
export function isReload(intent: LeaveIntent | null): boolean {
  return intent?.kind === 'reload'
}
