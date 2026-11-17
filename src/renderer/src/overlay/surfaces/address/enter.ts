/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { OMNIBOX_GROUPS, type OmniboxAction, type OmniboxCompletion, type OmniboxGroup, type OmniboxRow } from '@shared/omnibox'
import { looksLikeAddress } from '@shared/url'

// What Enter runs in the command bar, kept apart from the component
// so the rules are tested on their own.

export interface EnterState {
  /** The field's text (an inline completion included). */
  value: string
  /** What was typed, without the inline completion. */
  typed: string
  completion: OmniboxCompletion | null
  /** The text the shown rows answer, or null when none have arrived. */
  rowsFor: string | null
  rows: readonly OmniboxRow[]
}

/**
 * The action for Enter with no row picked: the inline completion when it is
 * showing, else the top row when it answers what is typed now. Null means the
 * rows are missing or stale (Enter came faster than they did), and the caller
 * asks main for fresh rows for the text instead.
 */
export function enterAction(state: EnterState): OmniboxAction | null {
  const { completion, value } = state
  if (completion && !completion.typo && value === completion.text) return { kind: 'navigate', url: completion.url }
  if (state.rowsFor === null || state.rowsFor !== state.typed) return null
  return state.rows[0]?.action ?? null
}

/** Where Enter (or a click) opens: ⌘ or Ctrl in a new tab behind, ⌥ in a new tab in front, else here. */
export function enterOptions(keys: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): { background?: true; newTab?: true } {
  if (keys.metaKey || keys.ctrlKey) return { background: true }
  if (keys.altKey) return { newTab: true }
  return {}
}

// ── DC-14: the Ask row follows a decision model ──
// After a pause in typing, the bar asks the new tab's search-or-ask question
// (DC-12). A sure "ask" for the text still in the field puts the Ask row
// first, so Enter with no row picked asks the companion; anything else
// leaves main's order alone.

/** What the decision model made of the typed text (the rule's "search" when it is off or unsure). */
export interface AskHint {
  text: string
  kind: 'search' | 'ask'
}

/** The text to ask about after a pause, or null: never in a private window, for an address, or under three characters (the question needs more). */
export function hintQuery(typed: string, isPrivate: boolean): string | null {
  const text = typed.trim()
  if (isPrivate || text.length < 3 || looksLikeAddress(text)) return null
  return text
}

/** The completion is written into the field after what was typed (not a typo hint). */
export function completesInline(completion: OmniboxCompletion | null, typed: string): completion is OmniboxCompletion {
  return completion !== null && !completion.typo && completion.text.length > typed.length && completion.text.toLowerCase().startsWith(typed.toLowerCase())
}

/** The hint stands: an "ask" for exactly what is typed now, with no inline completion turning the field into an address. */
export function askHinted(hint: AskHint | null, typed: string, completion: OmniboxCompletion | null): boolean {
  return hint !== null && hint.kind === 'ask' && hint.text === typed.trim() && !completesInline(completion, typed)
}

/** The Ask group first and the rest in main's order; a copy as it was when there is no Ask row. */
export function askFirst<G extends OmniboxGroup>(groups: readonly G[]): G[] {
  const at = groups.findIndex((g) => g.group === OMNIBOX_GROUPS.ask)
  if (at <= 0) return [...groups]
  return [groups[at] as G, ...groups.slice(0, at), ...groups.slice(at + 1)]
}
