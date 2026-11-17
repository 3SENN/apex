/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { registerSecret } from '../log'

// Bearer secrets for Atelier's local MCP server. Chat processes get a token
// derived from a secret made at launch, so each token opens only its own
// chat's tools and every token dies when Atelier quits.

export function newSecret(): Buffer {
  const secret = randomBytes(32)
  // The per-launch secret, in the encodings a log line could carry
  for (const encoding of ['hex', 'base64', 'base64url'] as const) registerSecret(secret.toString(encoding))
  return secret
}

/** The bearer token for one chat: HMAC-SHA256 of its id under the launch secret. */
export function chatToken(launchSecret: Buffer, chatId: string): string {
  const token = createHmac('sha256', launchSecret).update(`chat:${chatId}`).digest('base64url')
  // Tokens never reach a log line: the logger redacts every registered secret
  registerSecret(token)
  return token
}

/** Constant-time comparison; a missing or differently sized token is simply unequal. */
export function tokensEqual(given: string | null, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The token in an `Authorization: Bearer …` header, or null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  const match = value ? /^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})\s*$/.exec(value) : null
  return match?.[1] ?? null
}

/** A short, non-secret fingerprint (to tell whether a saved command still matches). */
export function fingerprint(...parts: string[]): string {
  return createHmac('sha256', 'atelier-fingerprint').update(parts.join('\n')).digest('hex').slice(0, 16)
}
