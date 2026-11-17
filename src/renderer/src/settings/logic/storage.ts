/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Storage maths (ST-53 to ST-55): the stacked bar's segments,
// which chats to list, and the reset dialog's checks. Pure, so tested.
import type { ChatStorageRow } from '@shared/services/settings'
import type { ResetStepView, StorageCategoryView } from '@shared/storage'

/** Images in chats older than this go with "Remove old chat images" (ST-54). */
export const OLD_IMAGE_DAYS = 30
/** The chat list shows this many before "Show all". */
export const CHAT_LIST_PREVIEW = 8
/** A segment never draws thinner than this share of the bar, so a small category still has something to point at. */
export const MIN_SEGMENT = 0.012

export interface StorageSegment {
  id: string
  label: string
  bytes: number
  /** 0 to 1 of the bar, after the minimum width; the shares add up to 1. */
  share: number
  /** The palette slot, 1 to 8, stable per category order. */
  tone: number
}

export function totalBytes(categories: readonly Pick<StorageCategoryView, 'bytes'>[]): number {
  return categories.reduce((sum, c) => sum + Math.max(0, c.bytes), 0)
}

/**
 * The bar's segments in category order. Empty categories leave the bar but
 * keep their legend entry; tiny ones are widened to MIN_SEGMENT and the rest
 * shrink to make room, so the shares still sum to 1.
 */
export function storageSegments(categories: readonly StorageCategoryView[]): StorageSegment[] {
  const sorted = [...categories].sort((a, b) => a.order - b.order)
  const tones = new Map(sorted.map((c, i) => [c.id, (i % 8) + 1]))
  const total = totalBytes(sorted)
  const filled = sorted.filter((c) => c.bytes > 0)
  if (total <= 0 || filled.length === 0) return []
  const raw = filled.map((c) => c.bytes / total)
  const small = raw.filter((s) => s < MIN_SEGMENT)
  const reserved = small.length * MIN_SEGMENT
  const bigTotal = raw.filter((s) => s >= MIN_SEGMENT).reduce((a, b) => a + b, 0)
  const scale = bigTotal > 0 ? Math.max(0, 1 - reserved) / bigTotal : 0
  return filled.map((c, i) => {
    const share = raw[i] ?? 0
    return { id: c.id, label: c.label, bytes: c.bytes, share: share < MIN_SEGMENT ? MIN_SEGMENT : share * scale, tone: tones.get(c.id) ?? 1 }
  })
}

/** Legend rows: every category, in order, with its palette slot (empty ones too). */
export function storageLegend(categories: readonly StorageCategoryView[]): Array<StorageCategoryView & { tone: number }> {
  return [...categories].sort((a, b) => a.order - b.order).map((c, i) => ({ ...c, tone: (i % 8) + 1 }))
}

/** Largest first; ties by most recently used. */
export function sortChatRows(rows: readonly ChatStorageRow[]): ChatStorageRow[] {
  return [...rows].sort((a, b) => b.bytes - a.bytes || b.updatedAt - a.updatedAt)
}

/** Steps a reset will run: the secrets ones only when the box is ticked. */
export function resetPlan(steps: readonly ResetStepView[], secrets: boolean): ResetStepView[] {
  return [...steps].filter((s) => secrets || !s.secrets).sort((a, b) => a.order - b.order)
}

/** The typed phrase matches, ignoring case and spaces at the ends. */
export function resetPhraseMatches(typed: string, phrase: string): boolean {
  return typed.trim().replace(/\s+/g, ' ').toLowerCase() === phrase.trim().toLowerCase()
}
