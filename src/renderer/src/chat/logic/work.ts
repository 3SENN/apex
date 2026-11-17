/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LogItem } from '../../agentLog'
import { t } from '@shared/i18n/core'

// The work fold: consecutive tool steps (and the reasoning between them)
// collapse into one line that says, in plain words, what the companion is
// doing or did. Labels come from main's describeToolCall wording.

export type ToolItem = Extract<LogItem, { kind: 'tool' }>
type AssistantItem = Extract<LogItem, { kind: 'assistant' }>

export type ReplyPart =
  | { kind: 'item'; item: LogItem }
  | {
      kind: 'work'
      key: string
      /** Steps and the thinking-only turns between them, in order. */
      items: Array<ToolItem | AssistantItem>
      steps: ToolItem[]
      running: boolean
      failed: number
    }

const isThinkingOnly = (item: LogItem): item is AssistantItem => item.kind === 'assistant' && !item.text.trim()

/** A reply's items with each run of tool steps folded into one part. */
export function replyParts(items: readonly LogItem[]): ReplyPart[] {
  const parts: ReplyPart[] = []
  let work: Extract<ReplyPart, { kind: 'work' }> | null = null
  for (const item of items) {
    if (item.kind === 'tool' || (work && isThinkingOnly(item))) {
      if (!work) {
        work = { kind: 'work', key: `work:${item.id}`, items: [], steps: [], running: false, failed: 0 }
        parts.push(work)
      }
      work.items.push(item as ToolItem | AssistantItem)
      if (item.kind === 'tool') {
        work.steps.push(item)
        if (item.state === 'running') work.running = true
        if (item.state === 'error') work.failed++
      }
      continue
    }
    work = null
    parts.push({ kind: 'item', item })
  }
  // A thinking-only turn that trails a fold (the model is still deciding) stays inside it.
  return parts
}

export type StepKind = 'page' | 'search' | 'act' | 'tabs' | 'memory' | 'other'

export function stepKind(label: string): StepKind {
  if (/^Search the web\b/.test(label)) return 'search'
  if (/^(Open|Read)\s+(https?:|www\.|\S+\.\S+)/.test(label) || /^Read (the page|interactive elements)/.test(label) || /^Find\b/.test(label)) return 'page'
  if (/^(Check|Save to|Update|Reorganize) memory\b|^Forget\b|^Memory\b/.test(label)) return 'memory'
  if (/^(Open a new tab|List tabs|Switch to|Close)\b/.test(label)) return 'tabs'
  if (/^(Click|Right-click|Middle-click|Double-click|Triple-click|Hover|Move the pointer|Drag|Press|Release|Hold|Scroll|Type|Fill|Wait|Zoom|Take a screenshot|Go back|Go forward|Reload)\b/.test(label)) return 'act'
  return 'other'
}

/** The host a step opened or read, for the favicon stack. */
export function stepHost(label: string): string | null {
  const match = /^(?:Open|Read)\s+(\S+)/.exec(label)
  if (!match?.[1]) return null
  try {
    const raw = match[1].replace(/…$/, '')
    const url = new URL(/^https?:/i.test(raw) ? raw : `https://${raw}`)
    return url.hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}

/** Distinct hosts in a fold, newest last, at most `max`. */
export function workHosts(steps: readonly ToolItem[], max = 3): string[] {
  const hosts: string[] = []
  for (const step of steps) {
    const host = stepHost(step.label)
    if (!host) continue
    const at = hosts.indexOf(host)
    if (at !== -1) hosts.splice(at, 1)
    hosts.push(host)
  }
  return hosts.slice(-max)
}

/** What a running step is doing, as a status line ("Reading 3 pages", "Searching for “x”"). */
export function activityLine(steps: readonly ToolItem[], name: string): string {
  const current = [...steps].reverse().find((s) => s.state === 'running') ?? steps[steps.length - 1]
  if (!current) return t('chat.work.isOnIt', { name })
  const kind = stepKind(current.label)
  const count = steps.filter((s) => stepKind(s.label) === kind).length
  switch (kind) {
    case 'page': {
      if (count > 1) return t('chat.work.readingPages', { count })
      const host = stepHost(current.label)
      if (/^Find\b/.test(current.label)) return t('chat.work.lookingThrough')
      return host ? t('chat.work.readingHost', { host }) : t('chat.work.readingPage')
    }
    case 'search': {
      const query = /"(.+)"/.exec(current.label)?.[1]
      return query ? t('chat.work.searchingFor', { query }) : t('chat.work.searchingWeb')
    }
    case 'memory':
      return /^Check/.test(current.label) ? t('chat.work.checkingMemory') : /^Forget/.test(current.label) ? t('chat.work.forgetting') : t('chat.work.savingMemory')
    case 'tabs':
      return t('chat.work.arrangingTabs')
    case 'act':
      if (/^Type|^Fill/.test(current.label)) return t('chat.work.filling')
      if (/^Take a screenshot|^Zoom/.test(current.label)) return t('chat.work.lookingAt')
      if (/^Scroll/.test(current.label)) return t('chat.work.scrolling')
      if (/^Wait/.test(current.label)) return t('chat.work.waitingPage')
      return t('chat.work.workingPage')
    case 'other':
      return t('chat.work.isOnIt', { name })
  }
}

/** A finished fold, summed up: "Read 3 pages and searched twice". */
export function workSummary(steps: readonly ToolItem[]): string {
  const count = (kind: StepKind): number => steps.filter((s) => stepKind(s.label) === kind).length
  const phrases: string[] = []
  const read = count('page')
  const searched = count('search')
  const acted = count('act')
  const memory = count('memory')
  const tabs = count('tabs')
  const other = count('other')
  if (read) phrases.push(t('chat.work.didRead', { count: read }))
  if (searched) phrases.push(t('chat.work.didSearch', { count: searched }))
  if (acted) phrases.push(t('chat.work.didAct', { count: acted }))
  if (memory) phrases.push(t('chat.work.didMemory'))
  if (tabs) phrases.push(t('chat.work.didTabs', { count: tabs }))
  if (other) phrases.push(t('chat.work.didTools', { count: other }))
  if (phrases.length === 0) return t('chat.work.workedOnIt')
  const text = phrases.length === 1 ? phrases[0]! : t('chat.work.listAnd', { rest: phrases.slice(0, -1).join(', '), last: phrases[phrases.length - 1]! })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// ── DS-55: the fold's tile stack ──

/** One tile in the fold's stack: a connector, a site, or (with neither) the kind of work. */
export type FoldTile =
  | { kind: 'connector'; id: string; name: string }
  | { kind: 'site'; host: string }
  | { kind: 'work'; step: StepKind }

/** Most tiles the stack shows; the rest go into the label's "+N more". */
export const FOLD_TILES_MAX = 3

/**
 * The fold's tiles: connectors first, then the sites it touched (newest
 * last), at most `max`; with neither, one tile per kind of work. `more`
 * counts the connectors and sites that didn't fit.
 */
export function foldStack(steps: readonly ToolItem[], connectors: ReadonlyArray<{ id: string; name: string }>, max = FOLD_TILES_MAX): { tiles: FoldTile[]; more: number } {
  const hosts = workHosts(steps, Number.POSITIVE_INFINITY)
  const all: FoldTile[] = [...connectors.map((c): FoldTile => ({ kind: 'connector', id: c.id, name: c.name })), ...hosts.map((host): FoldTile => ({ kind: 'site', host }))]
  if (all.length > 0) {
    // Connectors keep their place up front; the newest sites fill what's left.
    const shownConnectors = all.filter((t) => t.kind === 'connector').slice(0, max)
    const room = max - shownConnectors.length
    const shownSites = room > 0 ? all.filter((t) => t.kind === 'site').slice(-room) : []
    const tiles = [...shownConnectors, ...shownSites]
    return { tiles, more: all.length - tiles.length }
  }
  const kinds: StepKind[] = []
  for (const step of steps) {
    const kind = stepKind(step.label)
    if (!kinds.includes(kind)) kinds.push(kind)
  }
  if (kinds.length === 0) kinds.push('other')
  return { tiles: kinds.slice(0, max).map((step): FoldTile => ({ kind: 'work', step })), more: 0 }
}
