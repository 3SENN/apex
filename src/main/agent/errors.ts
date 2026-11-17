/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
import type { ChatError } from '@shared/chatErrors'
import { errorMessage } from './browserTool'
import { mainT } from '../i18n/mainT'

// SS-03: every failure of a chat run as one typed error. The message says
// what happened in plain words; the code picks the card's icon, tone and
// action. Provider quota points at the provider's console, never at a plan.

/** How long to wait before retrying a rate limit or overload when the API names no time. */
export const DEFAULT_RETRY_MS = 20_000
const MAX_RETRY_MS = 5 * 60_000

/** The Retry-After header in ms, or null. Works with fetch Headers and plain records. */
export function retryAfterMs(headers: unknown, now = Date.now()): number | null {
  if (!headers || typeof headers !== 'object') return null
  const read = (name: string): string | null => {
    const h = headers as { get?: (n: string) => string | null } & Record<string, unknown>
    if (typeof h.get === 'function') return h.get(name)
    const value = h[name] ?? h[name.toLowerCase()]
    return typeof value === 'string' ? value : null
  }
  const ms = read('retry-after-ms')
  if (ms && Number.isFinite(Number(ms))) return clampRetry(Number(ms))
  const raw = read('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return clampRetry(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? clampRetry(at - now) : null
}

function clampRetry(ms: number): number {
  return Math.min(MAX_RETRY_MS, Math.max(1000, Math.round(ms)))
}

const TOO_LONG = /prompt is too long|context.{0,20}(window|length)|too many tokens|maximum context/i
const TOO_LARGE = /too large|request_too_large|payload|exceeds.*(size|bytes)|image.*(too big|exceeds)/i
const QUOTA = /credit balance|billing|insufficient.?credit|quota|spend limit|usage limit/i
const OVERLOADED = /overloaded/i

/** A failure of the API-key engine, from the SDK's error classes. `hasKey` tells a missing key from a rejected one. */
export function classifyApiError(err: unknown, hasKey: boolean): ChatError {
  const detail = err instanceof Error ? err.message : String(err)
  if (err instanceof Anthropic.AuthenticationError) {
    return hasKey
      ? { code: 'key-rejected', message: mainT('chat.mainErrors.theAnthropicApiKey') }
      : { code: 'key-missing', message: mainT('chat.mainErrors.addYourAnthropicApi') }
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    if (QUOTA.test(detail)) return quota(detail)
    return { code: 'model-not-allowed', message: mainT('chat.mainErrors.thisApiKeyCan') }
  }
  if (err instanceof Anthropic.NotFoundError) return { code: 'model-not-allowed', message: mainT('chat.mainErrors.theChatSModel') }
  if (err instanceof Anthropic.RateLimitError) {
    if (QUOTA.test(detail)) return quota(detail)
    return { code: 'rate-limited', message: mainT('chat.mainErrors.theAnthropicApiRate'), retryAfterMs: retryAfterMs(err.headers) ?? DEFAULT_RETRY_MS }
  }
  if (err instanceof Anthropic.APIConnectionError) return { code: 'offline', message: mainT('chat.mainErrors.atelierCouldnTReach') }
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0
    if (status === 529 || OVERLOADED.test(detail)) {
      return { code: 'overloaded', message: mainT('chat.mainErrors.anthropicSServersAre'), retryAfterMs: retryAfterMs(err.headers) ?? DEFAULT_RETRY_MS }
    }
    if (status === 413 || (status === 400 && TOO_LARGE.test(detail) && !TOO_LONG.test(detail))) {
      return { code: 'too-large', message: mainT('chat.mainErrors.thatMessageIsToo') }
    }
    if (status === 400 && TOO_LONG.test(detail)) {
      return { code: 'too-long', message: mainT('chat.mainErrors.thisChatIsToo') }
    }
    if (QUOTA.test(detail)) return quota(detail)
    if (status >= 500) return { code: 'unavailable', message: mainT('chat.mainErrors.theAnthropicApiIs') }
    if (status === 400) return { code: 'other', message: mainT('chat.mainErrors.theApiRejectedThe', { detail }) }
    return { code: 'other', message: mainT('chat.mainErrors.anthropicApiError', { value: status ? ` ${status}` : '', detail }) }
  }
  if (!hasKey) return { code: 'key-missing', message: mainT('chat.mainErrors.addYourAnthropicApi') }
  return { code: 'other', message: errorMessage(err) }
}

function quota(detail: string): ChatError {
  void detail
  return { code: 'quota', message: mainT('chat.mainErrors.yourAnthropicAccountHas') }
}

/** A failed write to disk (SS-05): a full disk gets its own words. */
export function classifySaveError(err: unknown): ChatError {
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return { code: 'disk-full', message: mainT('chat.mainErrors.yourDiskIsFull') }
  return { code: 'other', message: mainT('chat.mainErrors.atelierCouldnTSave', { value: errorMessage(err) }) }
}
