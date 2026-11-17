/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { displayHost } from '@shared/domains'
import { flattenGroups, stepSelection, typedForm, type OmniboxGroup, type OmniboxRow } from '@shared/omnibox'
import { BUILT_IN_SEARCH_ENGINES, engineSearchUrl, type SearchEngineDef } from '@shared/searchEngines'
import { isBlankUrl, looksLikeAddress, omniboxToUrl, parseInternalUrl } from '@shared/url'

// The new tab's web search (NT-01): what Enter, ⌥Enter and each row of the
// start composer do, given the typed text, the remembered mode (ask the
// companion or search the web) and the default engine from Settings › Search.
// The local suggestions are the command bar's own rows (main's omnibox
// providers and their ranking), narrowed to open tabs, history and bookmarks.
// Pure, so tests/newtab-search.test.ts covers it without a DOM.

export type NewTabMode = 'companion' | 'web'

export type StartAction =
  /** The typed text is an address: go there (an apex:// page opens in place). */
  | { kind: 'go'; url: string; label: string; internal: boolean }
  | { kind: 'search'; url: string; engine: string; query: string }
  | { kind: 'ask'; text: string }

export interface StartPlan {
  /** Go to first when the text is an address, then the mode's own action, then the other one. */
  actions: StartAction[]
  /** What Enter runs with no row selected. */
  enter: StartAction | null
  /** What ⌥Enter runs: the action of the other mode. */
  alt: StartAction | null
}

/** "example.com" for a typed address, the address itself for an apex:// page or a file. */
function goLabel(url: string, internal: boolean): string {
  if (internal) return url
  return displayHost(url).display || typedForm(url)
}

/** The Go to action for typed text, or null when the text is not an address. */
export function goAction(text: string, engine: Pick<SearchEngineDef, 'template'>): Extract<StartAction, { kind: 'go' }> | null {
  const input = text.trim()
  if (!looksLikeAddress(input)) return null
  const url = omniboxToUrl(input, engine)
  if (isBlankUrl(url)) return null
  const internal = parseInternalUrl(url) !== null
  return { kind: 'go', url, label: goLabel(url, internal), internal }
}

export function startPlan(text: string, mode: NewTabMode, engine: Pick<SearchEngineDef, 'name' | 'template'>): StartPlan {
  const query = text.trim()
  if (!query) return { actions: [], enter: null, alt: null }
  const search: StartAction = { kind: 'search', url: engineSearchUrl(engine, query), engine: engine.name, query }
  const ask: StartAction = { kind: 'ask', text: query }
  const own = mode === 'web' ? search : ask
  const other = mode === 'web' ? ask : search
  const go = goAction(query, engine)
  const actions = go ? [go, own, other] : [own, other]
  return { actions, enter: actions[0] ?? null, alt: other }
}

/** The command bar's groups the start composer shows under it; engine suggestions only exist when Settings › Search allows them. */
const SHOWN_GROUPS: Record<NewTabMode, readonly string[]> = {
  companion: ['top', 'tabs', 'bookmarks', 'history'],
  web: ['top', 'suggest', 'tabs', 'bookmarks', 'history'],
}

export const START_SUGGESTIONS_MAX = 6

/**
 * The local suggestions for the start composer, in the command bar's group
 * and rank order, capped as a whole. Rows that only repeat the Go to action
 * (the same address) and rows that are not places (commands, the ask row)
 * drop out.
 */
export function startSuggestions(groups: readonly OmniboxGroup[], mode: NewTabMode, go: StartAction | null = null, max = START_SUGGESTIONS_MAX): OmniboxGroup[] {
  const shown = SHOWN_GROUPS[mode]
  const same = go?.kind === 'go' ? typedForm(go.url).toLowerCase() : null
  const out: OmniboxGroup[] = []
  let left = max
  for (const group of groups) {
    if (left <= 0) break
    if (!shown.includes(group.group)) continue
    const rows = group.rows
      .filter((r) => r.action.kind === 'navigate' || r.action.kind === 'switch-tab' || r.action.kind === 'open-internal')
      .filter((r) => !same || r.action.kind === 'switch-tab' || typedForm(r.url ?? (r.action.kind === 'navigate' ? r.action.url : '')).toLowerCase() !== same)
      .slice(0, left)
    if (rows.length === 0) continue
    out.push({ group: group.group, rows })
    left -= rows.length
  }
  return out
}

/** One entry of the list under the composer: an action, then the suggestion rows. */
export type StartEntry = { kind: 'action'; action: StartAction } | { kind: 'row'; row: OmniboxRow }

export function startEntries(plan: StartPlan, groups: readonly OmniboxGroup[]): StartEntry[] {
  return [...plan.actions.map((action) => ({ kind: 'action' as const, action })), ...flattenGroups(groups).map((row) => ({ kind: 'row' as const, row }))]
}

export interface StartKeyEvent {
  key: string
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  isComposing: boolean
}

export interface StartKeyState {
  /** The list under the composer is showing. */
  open: boolean
  count: number
  selected: number
  /** The text has more than one line, so ↑ and ↓ move the caret instead. */
  multiline: boolean
}

export type StartKey =
  | { kind: 'run'; index: number }
  | { kind: 'enter' }
  | { kind: 'alt' }
  | { kind: 'select'; index: number }
  | { kind: 'clear' }

/** What a key in the start composer does while there is text; null leaves it to the field (and the companion choice). */
export function startKey(e: StartKeyEvent, s: StartKeyState): StartKey | null {
  if (e.isComposing) return null
  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.altKey) return { kind: 'alt' }
    if (s.open && s.selected >= 0 && s.selected < s.count) return { kind: 'run', index: s.selected }
    return { kind: 'enter' }
  }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && s.open && !s.multiline && s.count > 0 && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    return { kind: 'select', index: stepSelection(s.selected, s.count, e.key === 'ArrowDown' ? 1 : -1, true) }
  }
  if (e.key === 'Escape' && s.open) return { kind: 'clear' }
  return null
}

/** The engine's letter mark (drawn, never a fetched favicon). */
export function engineMark(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

/** The engines the one-time choice offers: the first five built in, plus the current one when it is another. */
export function engineChoices(current: Pick<SearchEngineDef, 'id' | 'name' | 'template'>, count = 5): Array<Pick<SearchEngineDef, 'id' | 'name' | 'template'>> {
  const list: Array<Pick<SearchEngineDef, 'id' | 'name' | 'template'>> = BUILT_IN_SEARCH_ENGINES.slice(0, count)
  return list.some((e) => e.id === current.id) ? list : [...list, current]
}
