/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { COMPANION_NAME_MAX } from '@shared/companion'

// Companion names as the create sheet shows them. Main applies the same
// rules (uniqueName in src/main/companions.ts); the sheet uses these to say
// what the new companion will be called before it is added.

/** Trimmed, inner whitespace collapsed, cut to the length limit. */
export function cleanName(raw: string, max = COMPANION_NAME_MAX): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

/** `name`, or the same name with " 2", " 3"… when another companion has it (case-insensitive). */
export function uniqueCompanionName(name: string, taken: readonly string[], max = COMPANION_NAME_MAX): string {
  const used = new Set(taken.map((t) => t.toLowerCase()))
  const trimmed = cleanName(name, max) || 'Companion'
  if (!used.has(trimmed.toLowerCase())) return trimmed
  for (let n = 2; n < 10_000; n++) {
    const suffix = ` ${n}`
    const candidate = `${trimmed.slice(0, max - suffix.length).trimEnd()}${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return trimmed
}
