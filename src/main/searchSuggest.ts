/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { engineSuggestUrl, parseSuggestions, type SearchEngineDef } from '@shared/searchEngines'
import { looksLikeAddress } from '@shared/url'
import { log } from './log'

// Search-engine suggestions for the command bar (SH-35). Off by default
// (settings.searchSuggestions), because every keystroke then goes to the
// engine. Never for addresses or Atelier pages. Fetched in main with a short
// debounce, from an in-memory session with no cookies; aborted when the
// next keystroke arrives.

export const SUGGEST_DEBOUNCE_MS = 120
export const SUGGEST_TIMEOUT_MS = 3000
export const SUGGEST_BODY_MAX = 64 * 1024

export type SuggestFetch = (url: string, signal: AbortSignal) => Promise<unknown>

export interface SearchSuggestDeps {
  enabled(): boolean
  engine(): SearchEngineDef
  /** Injected in tests; main's default fetches in the cookie-less suggestion session. */
  fetch?: SuggestFetch
  debounceMs?: number
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/** Reads JSON from a capped response body. */
export async function readCappedJson(response: Response, max = SUGGEST_BODY_MAX): Promise<unknown> {
  if (!response.ok) return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

async function sessionFetch(url: string, signal: AbortSignal): Promise<unknown> {
  // Loaded lazily so the module stays importable in tests.
  const { session } = await import('electron')
  const ses = session.fromPartition('atelier-suggest')
  const response = await ses.fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(SUGGEST_TIMEOUT_MS)]), credentials: 'omit', headers: { accept: 'application/json' } } as RequestInit)
  return readCappedJson(response)
}

export function createSearchSuggest(deps: SearchSuggestDeps): { suggest(text: string, signal: AbortSignal): Promise<string[]> } {
  const fetcher = deps.fetch ?? sessionFetch
  return {
    async suggest(text, signal) {
      const query = text.trim()
      if (!deps.enabled() || !query || query.length > 200 || looksLikeAddress(query) || query.startsWith('atelier:')) return []
      const url = engineSuggestUrl(deps.engine(), query)
      if (!url) return []
      try {
        await wait(deps.debounceMs ?? SUGGEST_DEBOUNCE_MS, signal)
        return parseSuggestions(await fetcher(url, signal), query)
      } catch (err) {
        if (!signal.aborted) log.debug('omnibox', 'Search suggestions failed', { error: err instanceof Error ? err.message : String(err) })
        return []
      }
    },
  }
}
