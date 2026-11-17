/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StorageCategoryView } from '@shared/storage'
import { log } from './log'

// Storage categories. Each phase registers what it keeps on disk;
// Settings › Your data measures and clears them. A registers chats,
// chat-images, memory, history, website-data and cache.

export interface StorageCategory {
  id: string
  label: string
  order: number
  measure(): Promise<number>
  clear?: { label: string; run(): Promise<void> }
}

const categories = new Map<string, StorageCategory>()

export function registerStorageCategory(c: StorageCategory): () => void {
  if (categories.has(c.id)) throw new Error(`Storage category ${c.id} is already registered.`)
  categories.set(c.id, c)
  return () => {
    if (categories.get(c.id) === c) categories.delete(c.id)
  }
}

export function storageCategories(): StorageCategory[] {
  return [...categories.values()].sort((a, b) => a.order - b.order)
}

/** Measures every category; one that fails to measure shows 0 rather than hiding the list. */
export async function measureStorage(): Promise<StorageCategoryView[]> {
  return Promise.all(
    storageCategories().map(async (c) => {
      let bytes = 0
      try {
        bytes = await c.measure()
      } catch (err) {
        log.warn('storage', `Measuring ${c.id} failed`, { error: err instanceof Error ? err.message : String(err) })
      }
      return { id: c.id, label: c.label, order: c.order, bytes, clearLabel: c.clear?.label ?? null }
    }),
  )
}
