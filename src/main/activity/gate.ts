/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What activity memory may record (ST-49): the capture gating
// matrix, kept pure so every row of it is tested. Nothing is recorded while
// off, paused or outside the set hours, in a private window, from a tab the
// agent drives (that covers private chats), on a page that isn't a website
// (atelier://, atelier-app://, file://), on an excluded site, or on a page with
// password or payment fields (the guarded-field check).
import type { ActivityStatus } from '@shared/activity'
import { exclusionFor, type Exclusions } from '@shared/exclusions'

export type SkipReason = 'off' | 'paused' | 'outside-hours' | 'private' | 'agent' | 'not-web' | 'excluded' | 'guarded'

export interface GateInput {
  status: ActivityStatus
  url: string
  privateWindow: boolean
  agentControlled: boolean
  excluded: Exclusions
  /** Known only once the page is checked; undefined before that. */
  guarded?: boolean
}

export type GateResult = { ok: true } | { ok: false; reason: SkipReason }

export function captureGate(input: GateInput): GateResult {
  if (input.status.state === 'off') return { ok: false, reason: 'off' }
  if (input.status.state === 'paused') return { ok: false, reason: 'paused' }
  if (input.status.state === 'outside-hours') return { ok: false, reason: 'outside-hours' }
  if (input.privateWindow) return { ok: false, reason: 'private' }
  if (input.agentControlled) return { ok: false, reason: 'agent' }
  const match = exclusionFor(input.url, input.excluded)
  if (match?.kind === 'not-web') return { ok: false, reason: 'not-web' }
  if (match) return { ok: false, reason: 'excluded' }
  if (input.guarded === true) return { ok: false, reason: 'guarded' }
  return { ok: true }
}

/** Page text is kept only after this much time on the page. */
export const CAPTURE_DWELL_MS = 20_000
/** At most this much page text per capture. */
export const CAPTURE_TEXT_MAX = 20_000
/** Thumbnails are downscaled to this width. */
export const THUMBNAIL_WIDTH = 480

/**
 * Runs in an isolated world, so the page cannot redefine what it calls; it
 * only reads the DOM. True when the page holds a password or payment field.
 */
export const GUARDED_FIELDS_PROBE = `(() => {
  const selector = [
    'input[type="password"]',
    'input[autocomplete~="cc-number"]', 'input[autocomplete~="cc-csc"]', 'input[autocomplete~="cc-exp"]',
    'input[autocomplete~="current-password"]', 'input[autocomplete~="new-password"]',
    'input[name*="cardnumber" i]', 'input[name*="card-number" i]', 'input[name*="cvc" i]', 'input[name*="cvv" i]',
  ].join(',')
  return document.querySelector(selector) !== null
})()`
