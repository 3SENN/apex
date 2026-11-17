/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { REPORT_MAX_BYTES, type ReportDraft, type ReportEstimate } from '@shared/diagnostics'

// The problem report's live size line (OV-30). Main estimates everything
// but pasted images, which stay in the chrome so 25 MB of base64 doesn't
// cross IPC on every change; their bytes are added here.

export const ESTIMATE_DEBOUNCE_MS = 300

export type EstimateStatus = { kind: 'idle' } | { kind: 'busy'; last: ReportEstimate | null } | { kind: 'ready'; estimate: ReportEstimate } | { kind: 'error' }

/** Main's estimate plus the pasted images. */
export function withImages(estimate: ReportEstimate, imageBytes: number): ReportEstimate {
  if (imageBytes <= 0) return estimate
  const parts = [...estimate.parts.filter((p) => p.kind !== 'images'), { kind: 'images' as const, bytes: imageBytes }]
  const bytes = estimate.bytes - (estimate.parts.find((p) => p.kind === 'images')?.bytes ?? 0) + imageBytes
  return { bytes, overLimit: estimate.overLimit || bytes > REPORT_MAX_BYTES, parts }
}

/**
 * What decides the size, as a key: a change re-estimates, typing within the
 * same kilobyte of description does not.
 */
export function estimateKey(draft: ReportDraft, imageBytes: number): string {
  return JSON.stringify([Math.floor(draft.description.length / 1024), imageBytes, draft.fileTokens, draft.includeChatId, draft.includeScreenshotTabId, draft.includeCrashDumps])
}

/** The latest known estimate, kept while a new one is worked out. */
export function shownEstimate(status: EstimateStatus): ReportEstimate | null {
  if (status.kind === 'ready') return status.estimate
  if (status.kind === 'busy') return status.last
  return null
}

/** Over the limit as far as we know: saving stays off until a new estimate says otherwise. */
export function overLimit(status: EstimateStatus): boolean {
  return shownEstimate(status)?.overLimit ?? false
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
