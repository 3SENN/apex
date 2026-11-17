/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { UpdateDisabledReason, UpdateErrorKind, UpdateStatus } from '@shared/updates'

// The update state machine, pure: (status, event) → status. The phases are
// disabled, idle, checking, downloading, ready, installing and error. The
// controller feeds it backend events and its own decisions (consent, the
// free-space check, the watchdog); events that don't fit the phase are
// ignored, so a late progress tick can't pull a ready update back.

export type MachineEvent =
  | { type: 'disable'; reason: UpdateDisabledReason }
  | { type: 'enable' }
  | { type: 'checking' }
  | { type: 'available'; version: string; at: number; awaitingConsent: boolean }
  | { type: 'not-available'; at: number }
  | { type: 'download-started'; version: string }
  | { type: 'progress'; percent: number; bytesPerSecond: number }
  | { type: 'downloaded'; version: string }
  | { type: 'installing' }
  | { type: 'install-cancelled' }
  | {
      type: 'failed'
      kind: UpdateErrorKind
      message: string
      attempt: number
      retryAt: number | null
      at: number
      /** A failed check also records the check's outcome. */
      during: 'check' | 'download' | 'install'
      version?: string | null
    }
  | { type: 'unsupported'; value: UpdateStatus['unsupported'] }

const BUSY = new Set<UpdateStatus['phase']>(['downloading', 'ready', 'installing'])

export function reduce(s: UpdateStatus, e: MachineEvent): UpdateStatus {
  if (e.type === 'unsupported') return { ...s, unsupported: e.value }
  if (e.type === 'disable') {
    return { ...s, phase: 'disabled', disabledReason: e.reason, version: null, progress: null, bytesPerSecond: null, awaitingConsent: false, error: null }
  }
  if (s.phase === 'disabled') return e.type === 'enable' ? { ...s, phase: 'idle', disabledReason: null } : s
  switch (e.type) {
    case 'enable':
      return s
    case 'checking':
      if (BUSY.has(s.phase)) return s
      return { ...s, phase: 'checking', error: null }
    case 'available':
      if (s.phase === 'ready' || s.phase === 'installing') return s
      return {
        ...s,
        phase: e.awaitingConsent ? 'idle' : 'downloading',
        version: e.version,
        progress: e.awaitingConsent ? null : 0,
        bytesPerSecond: null,
        checkedAt: e.at,
        lastCheck: 'available',
        awaitingConsent: e.awaitingConsent,
        error: null,
      }
    case 'not-available':
      if (BUSY.has(s.phase)) return s
      return { ...s, phase: 'idle', version: null, progress: null, bytesPerSecond: null, checkedAt: e.at, lastCheck: 'up-to-date', awaitingConsent: false, error: null }
    case 'download-started':
      if (s.phase === 'ready' || s.phase === 'installing') return s
      return { ...s, phase: 'downloading', version: e.version, progress: 0, bytesPerSecond: null, awaitingConsent: false, error: null }
    case 'progress':
      if (s.phase !== 'downloading') return s
      return { ...s, progress: Math.min(1, Math.max(0, e.percent / 100)), bytesPerSecond: Math.max(0, e.bytesPerSecond) }
    case 'downloaded':
      if (s.phase === 'installing') return s
      return { ...s, phase: 'ready', version: e.version, progress: 1, bytesPerSecond: null, awaitingConsent: false, error: null }
    case 'installing':
      if (s.phase !== 'ready' && !(s.phase === 'error' && s.error?.kind === 'install')) return s
      return { ...s, phase: 'installing', error: null }
    case 'install-cancelled':
      return s.phase === 'installing' ? { ...s, phase: 'ready' } : s
    case 'failed':
      return {
        ...s,
        phase: 'error',
        version: e.version === undefined ? s.version : e.version,
        progress: null,
        bytesPerSecond: null,
        awaitingConsent: false,
        error: { kind: e.kind, message: e.message, attempt: e.attempt, retryAt: e.retryAt },
        ...(e.during === 'check' ? { checkedAt: e.at, lastCheck: 'failed' as const } : {}),
      }
  }
}

const NETWORK = /net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|timed? ?out|HttpError: 5\d\d|status code 5\d\d|offline/i
const SIGNATURE = /signature|codesign|code sign|not signed|could not be verified|sha512 checksum mismatch/i

/** Sorts an updater error into the status' kinds; only 'network' retries on its own. */
export function classifyError(err: unknown): UpdateErrorKind {
  const text = err instanceof Error ? `${err.name}: ${err.message} ${(err as { code?: unknown }).code ?? ''}` : String(err)
  if (SIGNATURE.test(text)) return 'signature'
  if (NETWORK.test(text)) return 'network'
  return 'unknown'
}

/** Why updates are off for this build, or null when they can run. */
export function disabledReasonFor(env: { packaged: boolean; updatesEnabled: boolean; platform: NodeJS.Platform; appImage: boolean }): UpdateDisabledReason | null {
  if (!env.packaged) return 'unpackaged'
  // deb and rpm installs update through the package manager; only the AppImage updates itself.
  if (env.platform === 'linux' && !env.appImage) return 'unsupported-package'
  if (!env.updatesEnabled) return 'unsigned'
  return null
}
