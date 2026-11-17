/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Images inside saved chats (ST-54): screenshots and pictures live in a
// chat's messages as base64 image blocks and in its log as small data-URL
// thumbnails. Settings › Storage measures them and can remove them while
// keeping every word: an image block becomes a short text note, and a
// thumbnail becomes a 1×1 transparent PNG so the log keeps its shape.

export const IMAGE_REMOVED_NOTE = '[An image was removed here to free up space.]'

/** A 1×1 transparent PNG: what a removed thumbnail turns into. */
export const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** Data URLs shorter than this are left alone (icons, the blank PNG itself). */
const MIN_DATA_URL = 512

export interface ImageStats {
  count: number
  /** Decoded bytes, estimated from the base64 length. */
  bytes: number
}

const base64Bytes = (length: number): number => Math.floor((length * 3) / 4)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An Anthropic image block with inline data: { type: 'image', source: { type: 'base64', data } }. */
function inlineImage(value: Record<string, unknown>): string | null {
  if (value.type !== 'image' || !isRecord(value.source)) return null
  const { source } = value
  return source.type === 'base64' && typeof source.data === 'string' ? source.data : null
}

function bigDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length >= MIN_DATA_URL && value.startsWith('data:image/')
}

/** Counts the images anywhere inside a chat's JSON (messages and log). */
export function measureImages(value: unknown, depth = 0): ImageStats {
  const stats: ImageStats = { count: 0, bytes: 0 }
  if (depth > 64) return stats
  if (bigDataUrl(value)) return { count: 1, bytes: base64Bytes(value.length - value.indexOf(',') - 1) }
  if (Array.isArray(value)) {
    for (const item of value) add(stats, measureImages(item, depth + 1))
    return stats
  }
  if (!isRecord(value)) return stats
  const data = inlineImage(value)
  if (data !== null) return { count: 1, bytes: base64Bytes(data.length) }
  for (const child of Object.values(value)) add(stats, measureImages(child, depth + 1))
  return stats
}

function add(into: ImageStats, more: ImageStats): void {
  into.count += more.count
  into.bytes += more.bytes
}

/**
 * Returns a copy with every image removed (and what went). Parts without
 * images are returned as they were, so unchanged chats are cheap to check.
 */
export function stripImages<T>(value: T, depth = 0): { value: T; removed: ImageStats } {
  const removed: ImageStats = { count: 0, bytes: 0 }
  const walk = (node: unknown, level: number): unknown => {
    if (level > 64) return node
    if (bigDataUrl(node)) {
      add(removed, { count: 1, bytes: base64Bytes(node.length - node.indexOf(',') - 1) })
      return BLANK_PNG
    }
    if (Array.isArray(node)) {
      let changed = false
      const next = node.map((item) => {
        const out = walk(item, level + 1)
        if (out !== item) changed = true
        return out
      })
      return changed ? next : node
    }
    if (!isRecord(node)) return node
    const data = inlineImage(node)
    if (data !== null) {
      add(removed, { count: 1, bytes: base64Bytes(data.length) })
      return { type: 'text', text: IMAGE_REMOVED_NOTE }
    }
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(node)) {
      const out = walk(child, level + 1)
      if (out !== child) changed = true
      next[key] = out
    }
    return changed ? next : node
  }
  return { value: walk(value, depth) as T, removed }
}

/** Chats whose last activity is older than `days` (the ST-54 30-day rule). */
export function olderThan<T extends { lastActiveAt?: number; updatedAt: number }>(chats: readonly T[], days: number, now = Date.now()): T[] {
  const cutoff = now - days * 86_400_000
  return chats.filter((c) => (c.lastActiveAt ?? c.updatedAt) < cutoff)
}
