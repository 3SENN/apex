/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Chat error types (SS-03). Main classifies every failure into one of
// these codes and sends it with the 'error' agent event; the chat draws a card
// with the code's icon, tone and action (chat/logic/errors.ts). Messages stay
// human-readable for older logs and exports, which have no code.
import { EXTRA_CHAT_ERROR_CODES } from '@internal/engines/shared'

export const CHAT_ERROR_CODES = [
  'offline',
  'rate-limited',
  'overloaded',
  'unavailable',
  'model-not-allowed',
  'too-large',
  'too-long',
  'refusal',
  'key-missing',
  'key-rejected',
  /** The provider's own quota or credit; Apex links to the provider's console, never to plans of its own. */
  'quota',
  'disk-full',
  'other',
  // The codes of the engines a build adds (src/shared/engine.ts).
  ...EXTRA_CHAT_ERROR_CODES,
] as const

export type ChatErrorCode = (typeof CHAT_ERROR_CODES)[number]

export interface ChatError {
  code: ChatErrorCode
  message: string
  /** Rate limits and overload: when to try again on its own. */
  retryAfterMs?: number
  /** The raw failure (an API error's JSON, say), for the card's Details; never the main text. */
  details?: string
  /** What the card fills its words with. */
  facts?: ChatErrorFacts
}

/** An engine's version and model errors: the versions and the model involved, when known. */
export interface ChatErrorFacts {
  /** The engine program's version that failed, e.g. '2.1.50'. */
  version?: string
  /** The version the model needs, e.g. '2.1.280'. */
  required?: string
  /** The chat's model id. */
  model?: string
  /** The floor is the organization's policy, not the model's. */
  policy?: boolean
}

/** Longest Details text kept with an error. */
export const ERROR_DETAILS_MAX = 4000

/** 'claude-opus-5-5' → 'Opus 5.5'; anything else as it is. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  if (!m?.[1]) return id
  return `${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`
}

/** Where provider quota and billing live: the provider's own console, opened in a tab. */
export const PROVIDER_CONSOLE_URL = 'https://console.anthropic.com/settings/billing'

export function isChatErrorCode(value: unknown): value is ChatErrorCode {
  return typeof value === 'string' && (CHAT_ERROR_CODES as readonly string[]).includes(value)
}
