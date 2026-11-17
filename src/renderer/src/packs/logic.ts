/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Packs page's pure helpers (docs/packs.md): ordering, what kind of thing
// a pack is, the filter, badges, the summary line under a pack's name, and
// when the review asks you to confirm.
import type { MessageKey } from '@shared/i18n/core'
import type { PackContributionCounts, PackDraftSummary, PackPermissionLine, PackSource, PackSummary } from '@shared/packs'

/** Yours first (by name), then the ones that come with Atelier. */
export function sortPacks(packs: readonly PackSummary[]): PackSummary[] {
  return [...packs].sort((a, b) => {
    const fa = a.source.kind === 'first-party' ? 1 : 0
    const fb = b.source.kind === 'first-party' ? 1 : 0
    return fa - fb || a.name.localeCompare(b.name)
  })
}

export function sortDrafts(drafts: readonly PackDraftSummary[]): PackDraftSummary[] {
  return [...drafts].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

/** What a pack is, by the main thing it brings: the type its card shows and the filter sorts by. */
export type PackKind = 'world' | 'game' | 'app' | 'companion' | 'look' | 'skills' | 'tools' | 'pack'

/** The filter's order. */
export const PACK_KINDS: readonly PackKind[] = ['app', 'game', 'world', 'skills', 'look', 'companion', 'tools', 'pack']

/** A world comes before its viewer app, a game before a tool, and a pack of only skills is Skills. */
export function packKind(p: Pick<PackSummary, 'apps' | 'worlds' | 'panels' | 'counts'>): PackKind {
  const c = p.counts
  if (p.worlds.length > 0 || c.worlds > 0) return 'world'
  if (p.apps.some((a) => a.kind === 'game')) return 'game'
  if (p.apps.length > 0 || p.panels.length > 0 || c.apps > 0 || c.panels > 0) return 'app'
  if (c.companions > 0) return 'companion'
  if (c.themes > 0 || c.assets > 0) return 'look'
  if (c.skills > 0 || c.routines > 0) return 'skills'
  if (c.tools + c.commands + c.menus + c.tweaks + c.connectors + c.cards > 0) return 'tools'
  return 'pack'
}

/** How many packs of each kind there are, in the filter's order, leaving out kinds with none. */
export function kindCounts(packs: readonly PackSummary[]): Array<{ kind: PackKind; count: number }> {
  const by = new Map<PackKind, number>()
  for (const p of packs) by.set(packKind(p), (by.get(packKind(p)) ?? 0) + 1)
  return PACK_KINDS.filter((k) => by.has(k)).map((kind) => ({ kind, count: by.get(kind) ?? 0 }))
}

/** Your packs filtered by kind (or all) and by every word of the search in its name, description, author or id. */
export function filterPacks<P extends PackSummary>(packs: readonly P[], kind: PackKind | 'all', text: string): P[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return packs.filter((p) => (kind === 'all' || packKind(p) === kind) && words.every((w) => `${p.name} ${p.description} ${p.author ?? ''} ${p.builtBy ?? ''} ${p.id}`.toLowerCase().includes(w)))
}

/** What a pack's card says about it, at most one: what needs you first, then that it's off. */
export function cardStatus(p: PackSummary): PackBadge | null {
  if (p.problems.length > 0) return { key: 'packs.tile.attention', tone: 'danger' }
  if (p.update) return { key: 'packs.tile.update', tone: 'info' }
  if (!p.enabled) return { key: 'packs.badge.off', tone: 'neutral' }
  if (p.waiting.length > 0) return { key: 'packs.badge.waiting', tone: 'warning' }
  if (p.withdrawn) return { key: 'packs.badge.withdrawn', tone: 'warning' }
  return null
}

/** What Open on a card opens: its one app, else its one world; a pack with several opens its details instead. */
export function cardOpens(p: Pick<PackSummary, 'apps' | 'worlds'>): { app: string } | { world: string } | null {
  if (p.apps.length === 1 && p.worlds.length === 0) return { app: (p.apps[0] as { id: string }).id }
  if (p.worlds.length === 1) return { world: (p.worlds[0] as { ref: string }).ref }
  if (p.apps.length === 1) return { app: (p.apps[0] as { id: string }).id }
  return null
}

/** The UI kit's Badge tones; spelled out so this module stays free of the kit (tests import it in node). */
type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface PackBadge {
  key: MessageKey
  tone?: BadgeTone
  vars?: Record<string, string | number>
}

export function packBadges(p: PackSummary): PackBadge[] {
  const out: PackBadge[] = []
  if (p.problems.length > 0) out.push({ key: 'packs.badge.problems', tone: 'danger' })
  if (!p.enabled) out.push({ key: 'packs.badge.off', tone: 'warning' })
  else if (p.problems.length === 0 && p.waiting.length > 0) out.push({ key: 'packs.badge.waiting', tone: 'warning' })
  if (p.withdrawn) out.push({ key: 'packs.badge.withdrawn', tone: 'danger' })
  if (p.managed) out.push({ key: 'packs.badge.managed', tone: 'info' })
  if (p.update) out.push({ key: p.update.added.length > 0 ? 'packs.badge.updateApproval' : 'packs.badge.update', tone: 'info', vars: { version: p.update.version } })
  if (p.source.kind === 'first-party') out.push({ key: 'packs.badge.firstParty' })
  else if (p.signature === 'unsigned') out.push({ key: 'packs.badge.unsigned', tone: 'warning' })
  return out
}

/** What a pack adds, as message parts ("2 skills · 1 panel · 3 tools"). */
export function countParts(c: PackContributionCounts): Array<{ key: MessageKey; count: number }> {
  const parts: Array<{ key: MessageKey; count: number }> = []
  const add = (key: MessageKey, count: number): void => {
    if (count > 0) parts.push({ key, count })
  }
  add('packs.count.apps', c.apps)
  add('packs.count.worlds', c.worlds)
  add('packs.count.assets', c.assets)
  add('packs.count.skills', c.skills)
  add('packs.count.tools', c.tools)
  add('packs.count.panels', c.panels)
  add('packs.count.cards', c.cards)
  add('packs.count.commands', c.commands + c.menus)
  add('packs.count.tweaks', c.tweaks)
  add('packs.count.themes', c.themes)
  add('packs.count.routines', c.routines)
  add('packs.count.companions', c.companions)
  add('packs.count.connectors', c.connectors)
  return parts
}

/** A danger line (reading sites and sending data out, page scripts, a local program) asks you to confirm before Install. */
export function needsConfirm(lines: readonly PackPermissionLine[]): boolean {
  return lines.some((l) => l.level === 'danger')
}

export function sourceKey(source: PackSource): MessageKey {
  switch (source.kind) {
    case 'file':
      return 'packs.source.file'
    case 'link':
      return 'packs.source.link'
    case 'index':
      return 'packs.source.index'
    case 'draft':
      return 'packs.source.draft'
    case 'dev':
      return 'packs.source.dev'
    default:
      return 'packs.source.firstParty'
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Whether a permission line is one an update adds (so the review can mark it). */
export function isAdded(line: PackPermissionLine, added: readonly PackPermissionLine[]): boolean {
  return added.some((a) => a.kind === line.kind && a.key === line.key)
}

/** Browse's filter: one kind (or all), and every word of the search in its name, description, author or id. */
export function filterBrowse<E extends { id: string; name: string; description: string; author: string | null; kind: string }>(entries: readonly E[], kind: 'all' | 'app' | 'world' | 'pack', text: string): E[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((e) => (kind === 'all' || e.kind === kind) && words.every((w) => `${e.name} ${e.description} ${e.author ?? ''} ${e.id}`.toLowerCase().includes(w)))
}
