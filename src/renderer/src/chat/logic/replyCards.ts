/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure rules behind the reply cards (CH-26, CH-27): the compaction
// divider's wording, how a token count reads, whether next steps can still
// be picked, a tab card's state, an artifact's format tile and the partial
// notice's message. No DOM, so it is unit-tested in node.
import { t } from '@shared/i18n/core'
import type { MemoryChange } from '@shared/ipc'
import type { LogItem } from '../../agentLog'

type Compaction = Extract<LogItem, { kind: 'compaction' }>
type Partial = Extract<LogItem, { kind: 'partial' }>

/** "about 12,000": two significant digits, so it never reads more exact than it is. */
export function approxTokens(count: number, locale?: string): string {
  const n = Math.max(0, Math.round(count))
  if (n < 100) return new Intl.NumberFormat(locale).format(n)
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 2 }).format(n)
}

/** What triggered a compaction and roughly what it replaced. */
export function compactionLines(item: Pick<Compaction, 'trigger' | 'replacedTokens' | 'thresholdTokens'>, locale?: string): { why: string; replaced: string | null } {
  const why =
    item.trigger === 'manual'
      ? t('composer.card.compaction.manual')
      : item.thresholdTokens && item.thresholdTokens > 0
        ? t('composer.card.compaction.auto', { tokens: approxTokens(item.thresholdTokens, locale) })
        : t('composer.card.compaction.autoPlain')
  const replaced = item.replacedTokens && item.replacedTokens > 0 ? t('composer.card.compaction.replaced', { tokens: approxTokens(item.replacedTokens, locale) }) : null
  return { why, replaced }
}

export function memoryOpLabel(op: MemoryChange['op']): string {
  switch (op) {
    case 'saved':
      return t('composer.card.memory.saved')
    case 'updated':
      return t('composer.card.memory.updated')
    case 'renamed':
      return t('composer.card.memory.renamed')
    case 'forgotten':
      return t('composer.card.memory.forgotten')
  }
}

const PARTIAL_KEYS = {
  'step-limit': 'composer.card.partial.step-limit',
  stopped: 'composer.card.partial.stopped',
  'cut-off': 'composer.card.partial.cut-off',
  error: 'composer.card.partial.error',
} as const

export function partialKey(reason: Partial['reason']): (typeof PARTIAL_KEYS)[Partial['reason']] {
  return PARTIAL_KEYS[reason]
}

/**
 * Next steps lock once you've sent something after them, and while a reply
 * is running; the latest set stays live so a click still writes the draft.
 */
export function suggestionsLocked(items: readonly Pick<LogItem, 'kind' | 'id'>[], id: string, running: boolean): boolean {
  if (running) return true
  const at = items.findIndex((i) => i.kind === 'suggestions' && i.id === id)
  if (at === -1) return true
  for (let i = at + 1; i < items.length; i++) {
    const item = items[i]
    if (item?.kind === 'user' || item?.kind === 'suggestions') return true
  }
  return false
}

export type TabCardState = 'active' | 'open' | 'closed'

export function tabCardState(tabId: string, openIds: readonly string[], activeId: string | null): TabCardState {
  if (!openIds.includes(tabId)) return 'closed'
  return tabId === activeId ? 'active' : 'open'
}

/** The format tile an artifact card shows in place of a live preview. */
export function artifactFormat(name: string, mediaType: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase()
  if (ext === 'svg' || mediaType === 'image/svg+xml') return 'SVG'
  if (ext === 'md' || ext === 'markdown' || mediaType === 'text/markdown') return 'MD'
  if (ext === 'html' || ext === 'htm' || mediaType === 'text/html') return 'HTML'
  if (ext === 'csv' || mediaType === 'text/csv') return 'CSV'
  if (ext === 'json' || mediaType === 'application/json') return 'JSON'
  return 'TXT'
}
