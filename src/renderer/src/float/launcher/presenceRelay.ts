/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QuickAskSignal } from '@shared/voice'

// DS-68: quick ask is one of the composers companions listen to. The
// launcher lives in its own window, so its signals travel through main to
// every chrome's presence store; this decides which ones are worth sending.

/** A typing signal is repeated at most this often while the text keeps changing. */
export const TYPING_REFRESH_MS = 1000

export interface RelayState {
  signal: QuickAskSignal | null
  at: number
}

/**
 * The signal to relay for an input event, or null to stay quiet: 'typing'
 * while the field has text (refreshed now and then, never per keystroke),
 * 'idle' when it empties or loses focus after typing, and 'sent' always.
 */
export function nextRelay(prev: RelayState, event: { kind: 'text'; text: string } | { kind: 'focus'; text: string } | { kind: 'blur' } | { kind: 'send' }, now: number): QuickAskSignal | null {
  if (event.kind === 'send') return 'sent'
  if (event.kind === 'blur') return prev.signal === 'typing' ? 'idle' : null
  const has = event.text.trim() !== ''
  if (!has) return prev.signal === 'typing' ? 'idle' : null
  if (prev.signal === 'typing' && now - prev.at < TYPING_REFRESH_MS) return null
  return 'typing'
}
