/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unsent composer text per chat. The chrome keeps it in memory for
// instant switching and writes it to main (drafts.ts) after a short pause, so
// it survives reloads and the panel-to-page hand-over in another window.

export interface DraftSyncDeps {
  save(chatId: string, text: string): Promise<void> | void
  load(chatId: string): Promise<string>
  delayMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export interface DraftSync {
  get(chatId: string): string
  set(chatId: string, text: string): void
  /** Fetches the saved draft once; resolves with what the composer should show. */
  hydrate(chatId: string): Promise<string>
  /** Writes every pending draft now (the window is closing). */
  flush(): void
  /** Whether the draft was loaded from main or set this session. */
  known(chatId: string): boolean
}

export const DRAFT_DELAY_MS = 400

export function createDraftSync(deps: DraftSyncDeps): DraftSync {
  const texts = new Map<string, string>()
  const known = new Set<string>()
  const pending = new Map<string, unknown>()
  const loading = new Map<string, Promise<string>>()
  const delay = deps.delayMs ?? DRAFT_DELAY_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const write = (chatId: string): void => {
    pending.delete(chatId)
    void Promise.resolve(deps.save(chatId, texts.get(chatId) ?? '')).catch(() => undefined)
  }

  return {
    get: (chatId) => texts.get(chatId) ?? '',
    known: (chatId) => known.has(chatId),
    set(chatId, text) {
      known.add(chatId)
      if ((texts.get(chatId) ?? '') === text && !pending.has(chatId)) return
      if (text) texts.set(chatId, text)
      else texts.delete(chatId)
      const timer = pending.get(chatId)
      if (timer !== undefined) clearTimer(timer)
      pending.set(chatId, setTimer(() => write(chatId), delay))
    },
    hydrate(chatId) {
      if (known.has(chatId)) return Promise.resolve(texts.get(chatId) ?? '')
      let load = loading.get(chatId)
      if (!load) {
        load = deps.load(chatId).then(
          (saved) => {
            loading.delete(chatId)
            // Typing that started meanwhile wins over the saved text.
            if (!known.has(chatId)) {
              known.add(chatId)
              if (saved) texts.set(chatId, saved)
            }
            return texts.get(chatId) ?? ''
          },
          () => {
            loading.delete(chatId)
            return texts.get(chatId) ?? ''
          },
        )
        loading.set(chatId, load)
      }
      return load
    },
    flush() {
      for (const [chatId, timer] of [...pending]) {
        clearTimer(timer)
        write(chatId)
      }
    },
  }
}
