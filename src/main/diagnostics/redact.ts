/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { homedir } from 'node:os'

// Log redaction. It runs on every log write and again when a
// report bundles the logs. It removes credentials (keys, Bearer and
// x-api-key values, every registered secret), URL queries, fragments and
// sign-in parts, and the home folder. Pure Node, so tests and the facade use it.

// Shorter values would redact ordinary words.
const MIN_SECRET_LENGTH = 6
const MASK = '[redacted]'
const secrets = new Set<string>()
let sorted: string[] = []
let home = safeHome()

function safeHome(): string {
  try {
    return homedir()
  } catch {
    return ''
  }
}

/** Registers a value that must never appear in a log line or report (API keys, tokens, per-launch secrets). */
export function registerSecret(value: string): void {
  const trimmed = value.trim()
  if (trimmed.length < MIN_SECRET_LENGTH || secrets.has(trimmed)) return
  secrets.add(trimmed)
  // Longest first, so a secret containing another is replaced whole.
  sorted = [...secrets].sort((a, b) => b.length - a.length)
}

/** How many secrets are registered (diagnostics only; never the values). */
export function secretCount(): number {
  return secrets.size
}

/** Tests point the home folder elsewhere; null restores the real one. */
export function setHomeForTests(dir: string | null): void {
  home = dir ?? safeHome()
}

/** Tests start from no registered secrets. */
export function clearSecretsForTests(): void {
  secrets.clear()
  sorted = []
}

// Shapes that look like credentials even when nobody registered them.
const KEY_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, MASK],
  // x-api-key: value, "x-api-key": "value", x-api-key=value
  [/\b(x-api-key"?\s*[:=]\s*"?)[^\s",;}]+/gi, `$1${MASK}`],
  [/\b(authorization"?\s*[:=]\s*"?)(?!Bearer\b)(?:(?:Basic|Token)\s+)?[^\s",;}]{8,}/gi, `$1${MASK}`],
]

// scheme://user:pass@host → scheme://host
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi
// The query and fragment of any URL with an authority; the address part stays.
const URL_QUERY = /\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Only the credential parts: registered secrets and key shapes. Used on text the user chose to include (description, chat). */
export function redactSecrets(text: string): string {
  let out = text
  for (const secret of sorted) if (out.includes(secret)) out = out.split(secret).join(MASK)
  for (const [pattern, replacement] of KEY_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Everything: secrets, URL queries, fragments and sign-in parts, and the home folder (as ~). */
export function redact(text: string): string {
  let out = redactSecrets(text)
  out = out.replace(URL_USERINFO, '$1').replace(URL_QUERY, '$1')
  if (home.length > 1) {
    const flags = process.platform === 'win32' ? 'gi' : 'g'
    out = out.replace(new RegExp(escapeRegExp(home), flags), '~')
    // file:// URLs and JSON-escaped Windows paths spell the folder differently.
    if (home.includes('\\')) out = out.replace(new RegExp(escapeRegExp(home.replace(/\\/g, '\\\\')), flags), '~').replace(new RegExp(escapeRegExp(home.replace(/\\/g, '/')), flags), '~')
  }
  return out
}

/** A data object with every string value redacted. */
export function redactData<T extends Record<string, string | number | boolean | null>>(data: T): T {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(data)) out[key] = typeof value === 'string' ? redact(value) : value
  return out as T
}

/** The origin of a URL for a log line ("log origins rather than full URLs"); '' when it has none. */
export function originOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? `${parsed.protocol}` : parsed.origin
  } catch {
    return ''
  }
}
