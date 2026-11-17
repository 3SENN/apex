/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EXTRA_ERROR_CARDS, extraErrorBody } from '@internal/engines/cards'
import { modelName, type ChatErrorCode, type ChatErrorFacts } from '@shared/chatErrors'
import type { MessageKey } from '@shared/i18n/core'

// SS-03: each chat error code as a card: an icon, a tone, a title (and maybe
// a line under it) and the action it offers. Older logs carry no code; their
// text still shows, with Retry, and a key mention still opens settings.
// The engines a build adds bring the cards for their own codes
// (`@internal/engines/cards`).

export type ErrorTone = 'info' | 'warning' | 'error'

/** What the card's button does. 'console' opens the provider's own console in a tab; Apex has no plans of its own. */
export type ErrorAction = 'retry' | 'settings' | 'model' | 'new-chat' | 'console' | 'engine' | /** The engine's own next step (an update, say), from its error card's hook. */ 'engine-step' | /** The composer's model picker. */ 'pick-model' | 'none'

export type ErrorIcon = 'offline' | 'wait' | 'busy' | 'unavailable' | 'model' | 'size' | 'long' | 'refusal' | 'key' | 'quota' | 'signed-out' | 'limit' | 'missing' | 'update' | 'disk' | 'other'

export interface ErrorCardModel {
  code: ChatErrorCode
  icon: ErrorIcon
  tone: ErrorTone
  title: MessageKey
  /** A line under the title; null shows the error's own message instead. */
  body: MessageKey | null
  /** The body's values (versions, model). */
  bodyVars?: Record<string, string>
  action: ErrorAction
  /** A second, quieter action (Retry next to Open settings, for example). */
  secondary: ErrorAction | null
  /** Rate limits and overload count down and try again by themselves. */
  autoRetry: boolean
}

/** A card without its code: what an engine's own codes map to. */
export type ErrorCardSpec = Omit<ErrorCardModel, 'code'>

/** A card's line under the title, with its values. */
export interface ErrorCardBody {
  body: MessageKey
  bodyVars: Record<string, string>
}

const PUBLIC_CARDS: Record<string, ErrorCardSpec> = {
  offline: { icon: 'offline', tone: 'warning', title: 'chat.error.offline.title', body: 'chat.error.offline.body', action: 'retry', secondary: null, autoRetry: false },
  'rate-limited': { icon: 'wait', tone: 'warning', title: 'chat.error.rateLimited.title', body: null, action: 'retry', secondary: null, autoRetry: true },
  overloaded: { icon: 'busy', tone: 'warning', title: 'chat.error.overloaded.title', body: null, action: 'retry', secondary: null, autoRetry: true },
  unavailable: { icon: 'unavailable', tone: 'error', title: 'chat.error.unavailable.title', body: null, action: 'retry', secondary: null, autoRetry: false },
  'model-not-allowed': { icon: 'model', tone: 'error', title: 'chat.error.modelNotAllowed.title', body: null, action: 'model', secondary: 'retry', autoRetry: false },
  'too-large': { icon: 'size', tone: 'error', title: 'chat.error.tooLarge.title', body: 'chat.error.tooLarge.body', action: 'none', secondary: null, autoRetry: false },
  'too-long': { icon: 'long', tone: 'warning', title: 'chat.error.tooLong.title', body: 'chat.error.tooLong.body', action: 'new-chat', secondary: null, autoRetry: false },
  refusal: { icon: 'refusal', tone: 'info', title: 'chat.error.refusal.title', body: null, action: 'none', secondary: null, autoRetry: false },
  'key-missing': { icon: 'key', tone: 'warning', title: 'chat.error.keyMissing.title', body: null, action: 'settings', secondary: null, autoRetry: false },
  'key-rejected': { icon: 'key', tone: 'error', title: 'chat.error.keyRejected.title', body: null, action: 'settings', secondary: 'retry', autoRetry: false },
  quota: { icon: 'quota', tone: 'warning', title: 'chat.error.quota.title', body: 'chat.error.quota.body', action: 'console', secondary: 'retry', autoRetry: false },
  'disk-full': { icon: 'disk', tone: 'error', title: 'chat.error.diskFull.title', body: 'chat.error.diskFull.body', action: 'retry', secondary: null, autoRetry: false },
  other: { icon: 'other', tone: 'error', title: 'chat.error.other.title', body: null, action: 'retry', secondary: null, autoRetry: false },
}

// Every code a build knows has a card; a code from a build with more engines falls back to 'other'.
const CARDS: Record<string, ErrorCardSpec> = { ...PUBLIC_CARDS, ...EXTRA_ERROR_CARDS }

/** Whether an uncoded notice's text is about the API key (older logs). */
export function mentionsKey(text: string): boolean {
  return /api key/i.test(text)
}

/** The card for an error notice. Without a code (older logs) a key mention opens settings and anything else retries. */
export function errorCard(code: ChatErrorCode | undefined, message = '', facts?: ChatErrorFacts): ErrorCardModel {
  const known: ChatErrorCode = code ?? (mentionsKey(message) ? 'key-missing' : 'other')
  const resolved: ChatErrorCode = CARDS[known] ? known : 'other'
  const card: ErrorCardModel = { code: resolved, ...(CARDS[resolved] as ErrorCardSpec) }
  const extra = extraErrorBody(resolved, facts, facts?.model ? modelName(facts.model) : null)
  return extra ? { ...card, ...extra } : card
}

/** The command line for the Details disclosure: the raw failure, trimmed of blank lines. */
export function detailsText(details: string | undefined): string | null {
  const text = details?.replace(/\n{3,}/g, '\n\n').trim()
  return text ? text : null
}

/** The composer's model picker opens on this window event, with `{ chatId }` (a card's Use another model). */
export const PICK_MODEL_EVENT = 'apex:pick-model'

/** When no Retry-After came with a rate limit or overload. */
export const DEFAULT_RETRY_MS = 20_000
/** Longer waits than this aren't counted down; the card offers Retry instead. */
export const MAX_AUTO_RETRY_MS = 5 * 60_000

/** Whole seconds left before the automatic retry; 0 once it is due. */
export function retrySecondsLeft(arrivedAt: number, retryAfterMs: number | undefined, now: number): number {
  const wait = Math.max(1000, retryAfterMs ?? DEFAULT_RETRY_MS)
  return Math.max(0, Math.ceil((arrivedAt + wait - now) / 1000))
}

export interface AutoRetryInput {
  card: ErrorCardModel
  retryAfterMs?: number
  /** The error arrived while this view was open (not replayed from the saved log). */
  live: boolean
  /** It is the chat's newest item: nothing was sent after it. */
  last: boolean
  /** This surface drives the chat; mirrors never retry. */
  driving: boolean
  /** It already retried once on its own. */
  retried: boolean
  online: boolean
}

/** Rate limits and overload retry once by themselves, from the driving surface, while online. */
export function shouldAutoRetry(input: AutoRetryInput): boolean {
  if (!input.card.autoRetry || !input.live || !input.last || !input.driving || input.retried || !input.online) return false
  return (input.retryAfterMs ?? DEFAULT_RETRY_MS) <= MAX_AUTO_RETRY_MS
}
