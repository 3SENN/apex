/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The keyed registry behind chat/cards/registry.ts: one entry per
// key, a later registration replaces the earlier one, and unregistering
// only removes the entry it put there. Generic and DOM-free, so the
// dispatch is unit-tested in node.

export interface KeyedRegistry<K, V> {
  register(key: K, value: V): () => void
  get(key: K): V | null
  has(key: K): boolean
}

export function createKeyedRegistry<K, V>(): KeyedRegistry<K, V> {
  const entries = new Map<K, V>()
  return {
    register(key, value) {
      entries.set(key, value)
      return () => {
        if (entries.get(key) === value) entries.delete(key)
      }
    },
    get: (key) => entries.get(key) ?? null,
    has: (key) => entries.has(key),
  }
}
