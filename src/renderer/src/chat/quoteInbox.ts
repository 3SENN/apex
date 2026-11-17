/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { QuoteInput } from '@shared/services/chat'
import { withQuote } from '@shared/quote'

// OV-20's quote on its way into the panel's composer. Main's
// `chat-open` event drops it here (the selection chip's Ask, ⌘J with a
// selection, the page menu); the panel composer shows it as a chip and puts
// it ahead of your words when you send. One quote at a time: a new one
// replaces the last.

let pending: QuoteInput | null = null
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) listener()
}

export function pushQuote(quote: QuoteInput): void {
  pending = quote
  changed()
}

export function clearQuote(): void {
  if (!pending) return
  pending = null
  changed()
}

export function pendingQuote(): QuoteInput | null {
  return pending
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The quote waiting for this composer (only the panel's composer takes quotes). */
export function useQuote(enabled: boolean): QuoteInput | null {
  const quote = useSyncExternalStore(subscribe, pendingQuote)
  return enabled ? quote : null
}

/** The message as it goes out: the quote (when this composer holds one) ahead of what was typed. */
export function messageWithQuote(enabled: boolean, typed: string): string {
  return enabled ? withQuote(pending, typed) : typed
}
