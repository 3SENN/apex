/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { dedupeGroups, inlineCompletion, isStrongCandidate, textScore, frecency, type OmniboxCompletion, type OmniboxGroup, type OmniboxProvider, type OmniboxQueryContext } from '@shared/omnibox'
import type { HistoryStore } from './history'
import { log } from './log'

// Command-bar providers. Every source of rows, the built-in groups
// included, registers here; the bar shows groups in provider order, each
// capped at its maxRows. A provider that fails or is aborted contributes nothing.

const providers: OmniboxProvider[] = []

export const omnibox = {
  registerProvider(p: OmniboxProvider): () => void {
    if (providers.some((x) => x.id === p.id)) throw new Error(`Command-bar provider ${p.id} is already registered.`)
    providers.push(p)
    providers.sort((a, b) => a.order - b.order)
    return () => {
      const i = providers.indexOf(p)
      if (i >= 0) providers.splice(i, 1)
    }
  },

  async query(text: string, ctx: OmniboxQueryContext): Promise<OmniboxGroup[]> {
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          return { p, rows: (await p.query(text, ctx)).slice(0, p.maxRows) }
        } catch (err) {
          if (!ctx.signal.aborted) log.warn('omnibox', `Provider ${p.id} failed`, { error: err instanceof Error ? err.message : String(err) })
          return { p, rows: [] }
        }
      }),
    )
    if (ctx.signal.aborted) return []
    const groups: OmniboxGroup[] = []
    for (const { p, rows } of results) {
      if (rows.length === 0) continue
      const group = groups.find((g) => g.group === p.group)
      if (group) group.rows.push(...rows)
      else groups.push({ group: p.group, rows: [...rows] })
    }
    // A page shows once, in the first group that has it.
    return dedupeGroups(groups)
  },

  providers(): readonly OmniboxProvider[] {
    return providers
  },
}

// Unfinished command-bar text per tab (SH-35); a tab's draft goes with it.
const drafts = new Map<string, string>()
const DRAFT_MAX = 2048

export const omniboxDrafts = {
  get(tabId: string): string | null {
    return drafts.get(tabId) ?? null
  },
  set(tabId: string, text: string | null): void {
    if (text === null || text.trim() === '') drafts.delete(tabId)
    else drafts.set(tabId, text.slice(0, DRAFT_MAX))
  },
  forget(tabId: string): void {
    drafts.delete(tabId)
  },
}

/** The inline completion for typed text from history (SH-35): strong candidates only, best first. */
export function completeFromHistory(history: HistoryStore | null, text: string, now = Date.now()): OmniboxCompletion | null {
  const input = text.trim()
  if (!history || !input) return null
  const picked = history.pickFor(input, now)
  const candidates: Array<{ url: string; strong: boolean; score: number }> = []
  for (const entry of history.entries()) {
    // Prefix matches on the address, plus anything that could be a one-typo host.
    const match = textScore('', entry.url, input)
    if (match < 100 && !(input.length >= 4 && entry.url.length > 0)) continue
    candidates.push({ url: entry.url, strong: isStrongCandidate(entry, now, picked === entry.url), score: frecency(entry, Math.max(match, 1), now) + (picked === entry.url ? 1000 : 0) })
  }
  candidates.sort((a, b) => b.score - a.score)
  return inlineCompletion(input, candidates.slice(0, 200))
}

// ── packs command runner ── (docs/packs.md: a pack's command-bar row runs through the packs runtime)
type PackCommandRunner = (win: import('./features/types').WindowContext, tabId: string, packId: string, commandId: string) => void
let packCommandRunner: PackCommandRunner | null = null

export function setPackCommandRunner(fn: PackCommandRunner | null): void {
  packCommandRunner = fn
}

/** Runs a pack's command; false when packs aren't running. */
export function runPackCommand(win: import('./features/types').WindowContext, tabId: string, packId: string, commandId: string): boolean {
  if (!packCommandRunner) return false
  packCommandRunner(win, tabId, packId, commandId)
  return true
}
