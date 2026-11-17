/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The selection chip's rules in the page (OV-20), apart from the DOM so they
// are unit-tested: never inside password or other guarded fields, never in
// editable text at all (the chip would sit over what you type), and only a
// real, non-empty selection is reported.
import type { PageRect, PageSelectionMessage } from '@shared/ipc'
import { cleanLinks, cleanSelection } from '@shared/quote'

export interface FocusFacts {
  tag: string
  type: string | null
  autocomplete: string | null
  editable: boolean
}

const GUARDED_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-[a-z-]+)\b/i

/** Selections in these never leave the page. */
export function selectionBlocked(focus: FocusFacts | null): boolean {
  if (!focus) return false
  const tag = focus.tag.toLowerCase()
  if (focus.editable) return true
  if (tag === 'textarea' || tag === 'select') return true
  if (tag === 'input') return true
  return GUARDED_AUTOCOMPLETE.test(focus.autocomplete ?? '') || (focus.type ?? '').toLowerCase() === 'password'
}

export interface SelectionFacts {
  text: string
  collapsed: boolean
  rect: PageRect | null
  links: string[]
  url: string
  /** The selection's ends are inside a password field or an editable region. */
  blocked: boolean
}

/** What the page reports: the selection, or cleared when there is nothing to offer. */
export function selectionMessage(facts: SelectionFacts): PageSelectionMessage {
  if (facts.collapsed || facts.blocked || !facts.rect) return { cleared: true }
  const text = cleanSelection(facts.text)
  if (!text) return { cleared: true }
  if (facts.rect.width <= 0 && facts.rect.height <= 0) return { cleared: true }
  const rect = { x: Math.round(facts.rect.x), y: Math.round(facts.rect.y), width: Math.round(facts.rect.width), height: Math.round(facts.rect.height) }
  return { text, rect, links: cleanLinks(facts.links), url: facts.url }
}

/** Whether two reports say the same thing, so a mouseup on the same selection isn't sent twice. */
export function sameSelection(a: PageSelectionMessage | null, b: PageSelectionMessage): boolean {
  if (!a) return false
  if ('cleared' in a || 'cleared' in b) return 'cleared' in a && 'cleared' in b
  return a.text === b.text && a.url === b.url && a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.width === b.rect.width
}
