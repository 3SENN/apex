/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Search, owner filters and grouping shared by the Skills, Routines and
// Connectors pages, plus small helpers for skills and memory paths.
import { SHARED_OWNER } from '@shared/chats'
import { t } from '@shared/i18n/core'

export interface OwnerCompanion {
  id: string
  name: string
  hidden: boolean
}

/** 'all', 'shared', or a companion id. */
export type OwnerFilter = string

export const ALL_OWNERS = 'all'

/** True when every word of the query appears in one of the fields (case- and accent-insensitive). */
export function matchesQuery(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const haystack = fold(fields.filter(Boolean).join(' \u0000 '))
  return words.every((w) => haystack.includes(w))
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function matchesOwner(owner: string, filter: OwnerFilter): boolean {
  return filter === ALL_OWNERS || owner === filter
}

/** "Shared", a companion's name, or a neutral label for a companion that no longer exists. */
export function ownerName(owner: string, companions: readonly OwnerCompanion[]): string {
  if (owner === SHARED_OWNER) return t('settings.filters.shared')
  return companions.find((c) => c.id === owner)?.name ?? t('settings.filters.removedCompanion')
}

export interface OwnerOption {
  value: string
  label: string
}

/** Filter choices: everyone, shared items, then each companion (hidden ones marked). */
export function ownerFilterOptions(companions: readonly OwnerCompanion[]): OwnerOption[] {
  return [
    { value: ALL_OWNERS, label: t('settings.filters.allCompanions') },
    { value: SHARED_OWNER, label: t('settings.filters.shared') },
    ...companions.map((c) => ({ value: c.id, label: c.hidden ? t('settings.filters.hidden', { name: c.name }) : c.name })),
  ]
}

/** Choices for who owns an item in an editor: shared first, then each companion. */
export function ownerChoices(companions: readonly OwnerCompanion[], sharedLabel = t('settings.filters.sharedWithAllCompanions')): OwnerOption[] {
  return [{ value: SHARED_OWNER, label: sharedLabel }, ...companions.map((c) => ({ value: c.id, label: c.hidden ? t('settings.filters.hidden', { name: c.name }) : c.name }))]
}

export interface OwnerGroup<T> {
  owner: string
  label: string
  items: T[]
}

/** Shared items first, then each companion in list order, then owners that no longer exist. */
export function groupByOwner<T extends { owner: string }>(items: readonly T[], companions: readonly OwnerCompanion[]): OwnerGroup<T>[] {
  const order = [SHARED_OWNER, ...companions.map((c) => c.id)]
  const groups = new Map<string, T[]>()
  for (const item of items) groups.set(item.owner, [...(groups.get(item.owner) ?? []), item])
  const owners = [...groups.keys()].sort((a, b) => rank(order, a) - rank(order, b))
  return owners.map((owner) => ({ owner, label: groupLabel(owner, companions), items: groups.get(owner) ?? [] }))
}

function rank(order: string[], owner: string): number {
  const i = order.indexOf(owner)
  return i === -1 ? order.length : i
}

function groupLabel(owner: string, companions: readonly OwnerCompanion[]): string {
  return owner === SHARED_OWNER ? t('settings.filters.sharedWithAllCompanions') : ownerName(owner, companions)
}

// ---- skills ----

export const SKILL_NAME_MAX = 40

/** What the name field turns typing into: lowercase, dashes for spaces, nothing else. */
export function skillNameDraft(input: string): string {
  return input
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SKILL_NAME_MAX)
}

export function skillNameError(name: string): string | null {
  if (!name) return t('settings.filters.giveTheSkillA')
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return t('settings.filters.useLowercaseLettersAnd')
  return null
}

export type SkillSort = 'used' | 'updated' | 'name'

export function sortSkills<T extends { name: string; updatedAt: number; lastUsedAt: number | null }>(skills: readonly T[], sort: SkillSort): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name)
  if (sort === 'name') return [...skills].sort(byName)
  if (sort === 'updated') return [...skills].sort((a, b) => b.updatedAt - a.updatedAt || byName(a, b))
  // Recently used first; never-used skills follow, newest edit first.
  return [...skills].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1) || b.updatedAt - a.updatedAt || byName(a, b))
}

// ---- memory ----

const MEMORY_ROOT = '/memories/'

/**
 * Turns a typed file name into a /memories/ path, or null when it can't be
 * one (empty, a folder, or stepping outside with ..).
 */
export function memoryFilePath(input: string): string | null {
  let path = input.trim().replace(/\\/g, '/')
  if (!path) return null
  if (path.startsWith(MEMORY_ROOT)) path = path.slice(MEMORY_ROOT.length)
  path = path.replace(/^\/+/, '')
  if (!path || path.endsWith('/')) return null
  const parts = path.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.includes('\0'))) return null
  // Plain names become Markdown notes.
  const last = parts[parts.length - 1] ?? ''
  if (!last.includes('.')) parts[parts.length - 1] = `${last}.md`
  return MEMORY_ROOT + parts.join('/')
}

/** A memory path as shown in lists, without the /memories/ prefix. */
export function memoryDisplayName(path: string): string {
  return path.startsWith(MEMORY_ROOT) ? path.slice(MEMORY_ROOT.length) : path
}

// ---- connectors ----

/** The URL problem to show before saving, or null. Main checks again (https, or http on this computer). */
export function connectorUrlError(url: string): string | null {
  const text = url.trim()
  if (!text) return t('settings.filters.pasteTheServerS')
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return t('settings.filters.enterTheFullUrl')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return t('settings.filters.connectorsMustUseHttps')
  return null
}
