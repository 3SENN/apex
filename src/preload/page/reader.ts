/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcRenderer } from 'electron'
import { READER_CHANNEL, readerAllowedUrl, type PageReaderResult, type PageReaderState } from '@shared/reader'
import { extractArticle, pageReaderable } from './readerExtract'

// Reader, page side (RD-01): tells main whether the page reads as an article
// (after it loads, and again when its address changes in place), and extracts
// the article when main asks. Isolated world, top frame only; it exposes
// nothing to the page and reads the page without changing it.

/** Looks again at these delays after each trigger: pages often fill in their article after load. */
const AFTER_READY = [0, 1500]
const AFTER_LOAD = [0, 2000, 6000]
const AFTER_MOVE = [300, 1500, 4000]

export function installReader(): void {
  // Only real documents on web pages or local files (never a frame stub without a DOM).
  if (typeof document === 'undefined' || !readerAllowedUrl(window.location?.href ?? '')) return
  let last: PageReaderState | null = null
  let timers: ReturnType<typeof setTimeout>[] = []

  const report = (): void => {
    let readerable = false
    try {
      readerable = document.body !== null && pageReaderable(document)
    } catch {
      readerable = false
    }
    const state: PageReaderState = { url: window.location.href, readerable }
    if (last && last.url === state.url && last.readerable === state.readerable) return
    last = state
    ipcRenderer.send(READER_CHANNEL.state, state)
  }
  const schedule = (delays: readonly number[]): void => {
    for (const timer of timers) clearTimeout(timer)
    timers = delays.map((ms) => setTimeout(report, ms))
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => schedule(AFTER_READY), { once: true })
  else schedule(AFTER_READY)
  window.addEventListener('load', () => schedule(AFTER_LOAD), { once: true })

  ipcRenderer.on(READER_CHANNEL.check, () => {
    last = null
    schedule(AFTER_MOVE)
  })
  ipcRenderer.on(READER_CHANNEL.extract, (_event, raw: unknown) => {
    const requestId = raw && typeof raw === 'object' ? (raw as { requestId?: unknown }).requestId : undefined
    if (typeof requestId !== 'number') return
    let reply: PageReaderResult
    try {
      const article = extractArticle(document, window.location.href)
      reply = article ? { requestId, ok: true, article } : { requestId, ok: false, error: 'no-article' }
    } catch (err) {
      reply = { requestId, ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' }
    }
    ipcRenderer.send(READER_CHANNEL.result, reply)
  })
}
