/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Experiments at atelier://flags (in no nav). Values are stored in the
// `flags` setting; a child flag is locked while its parent is off.
import { BRAND_NAME } from './branding'
import type { MessageKey } from './i18n/core'

export interface FlagDef {
  id: string
  title: string
  description: string
  /** The translated title and description (t()), when the flag has them; `title` and `description` stay the English fallback. */
  titleKey?: MessageKey
  descriptionKey?: MessageKey
  /** ISO date the flag was added, for sorting and expiry review. */
  addedAt: string
  values: string[]
  default: string
  requiresRestart: boolean
  parent?: string
}

/** A flag as atelier://flags shows it: its value now, whether its parent locks it, and whether a restart is waiting. */
export type FlagState = FlagDef & { value: string; locked: boolean; pendingRestart: boolean }

/** The catalogue. Newest first on the page; `addedAt` also drives expiry review. */
export const FLAG_DEFS: readonly FlagDef[] = [
  // Packs (docs/packs.md): the tools companions build packs with.
  {
    id: 'pack-builder',
    title: 'Companions build packs',
    description: 'Gives companions the tools to write, test and propose packs in a chat. You still review and install every pack yourself.',
    titleKey: 'platform.flags.packBuilder.title',
    descriptionKey: 'platform.flags.packBuilder.description',
    addedAt: '2026-11-02',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
  // Sign-in compatibility (src/main/signInIdentity.ts): the fallback should Google refuse the Chrome identity.
  {
    id: 'google-signin-firefox',
    title: 'Google sign-in: present as Firefox',
    description: `On Google’s sign-in pages, ${BRAND_NAME} presents itself as Firefox instead of Chrome. Try this only if Google says the browser may not be secure.`,
    titleKey: 'platform.flags.googleSignInFirefox.title',
    descriptionKey: 'platform.flags.googleSignInFirefox.description',
    addedAt: '2026-10-30',
    values: ['off', 'on'],
    default: 'off',
    requiresRestart: false,
  },
  // The en-XA test language for truncation shots.
  {
    id: 'pseudo-locale',
    title: 'Pseudo-locale',
    description: 'Shows the interface in an accented, longer test language so clipped or untranslated text stands out.',
    addedAt: '2026-10-29',
    values: ['off', 'on'],
    default: 'off',
    requiresRestart: false,
  },
  {
    id: 'calendar-watch',
    title: 'Live calendar updates',
    description: `Keeps the Calendar helper listening for changes, so new or moved meetings show up at once instead of at the next check. Starts with ${BRAND_NAME}.`,
    addedAt: '2026-10-28',
    values: ['off', 'on'],
    default: 'off',
    requiresRestart: true,
  },
  {
    id: 'tables-agent-writes',
    title: 'Let companions change tables',
    description: 'Offers write_table, so a companion can add, edit or remove rows. Every change shows the statement first and asks you.',
    addedAt: '2026-10-27',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
    parent: 'tables',
  },
  {
    id: 'tables',
    title: 'Tables',
    description: 'Import CSV files into local tables, under Workspace › Files, that your companions can query.',
    addedAt: '2026-10-27',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
  {
    id: 'apps',
    title: 'Apps',
    description: 'Lets companions build small single-page tools that run sandboxed, with no network access.',
    addedAt: '2026-10-27',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
  {
    id: 'delegation',
    title: 'Helper chats',
    description: 'Lets a companion hand parts of a bigger task to up to three helper chats that work side by side.',
    addedAt: '2026-10-26',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
  {
    id: 'activity-screenshots',
    title: 'Activity memory thumbnails',
    description: 'Keeps small, downscaled thumbnails of pages in activity memory. Pages with password or payment fields are never captured.',
    addedAt: '2026-10-26',
    values: ['off', 'on'],
    default: 'off',
    requiresRestart: false,
  },
  {
    id: 'timeline',
    title: 'Timeline',
    description: 'Shows a Timeline view on the History page: your browsing by day, with site insights.',
    addedAt: '2026-10-25',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
  {
    id: 'details-panel-auto-open',
    title: 'Open chat details by itself',
    description: 'Opens the details panel beside a chat page the first time a plan or a produced file appears.',
    addedAt: '2026-10-25',
    values: ['off', 'on'],
    default: 'on',
    requiresRestart: false,
  },
]

const BY_ID = new Map(FLAG_DEFS.map((f) => [f.id, f]))

export function flagDef(id: string): FlagDef | undefined {
  return BY_ID.get(id)
}

/** A flag's own value: the stored one if the catalogue still allows it, else its default. Unknown flags are 'off'. */
export function flagValue(values: Record<string, string>, id: string): string {
  const def = BY_ID.get(id)
  if (!def) return 'off'
  const stored = values[id]
  return stored !== undefined && def.values.includes(stored) ? stored : def.default
}

/** Whether a flag is on: its value isn't 'off', and every parent up the chain is on too. Unknown flags are off. */
export function isFlagOn(values: Record<string, string>, id: string): boolean {
  const seen = new Set<string>()
  for (let def = BY_ID.get(id); def; def = def.parent ? BY_ID.get(def.parent) : undefined) {
    if (seen.has(def.id)) return false
    seen.add(def.id)
    if (flagValue(values, def.id) === 'off') return false
  }
  return seen.size > 0
}

/** Locked: some parent is off, so the flag shows as off and can't be changed. */
export function isFlagLocked(values: Record<string, string>, id: string): boolean {
  const def = BY_ID.get(id)
  return def?.parent !== undefined && !isFlagOn(values, def.parent)
}

/** Every flag as the page lists it, newest first. `launch` is what was set when Atelier started, for the restart banner. */
export function flagStates(values: Record<string, string>, launch: Record<string, string> = values): FlagState[] {
  return [...FLAG_DEFS]
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : 0))
    .map((def) => {
      const locked = isFlagLocked(values, def.id)
      return {
        ...def,
        value: locked ? 'off' : flagValue(values, def.id),
        locked,
        pendingRestart: def.requiresRestart && flagValue(values, def.id) !== flagValue(launch, def.id),
      }
    })
}

/** The stored values after setting one flag. Refuses unknown flags, values the flag doesn't offer, and locked flags. */
export function applyFlag(values: Record<string, string>, id: string, value: string): Record<string, string> {
  const def = BY_ID.get(id)
  if (!def) throw new Error(`There is no experiment called ${id}.`)
  if (!def.values.includes(value)) throw new Error(`${def.title} can't be set to ${value}.`)
  if (isFlagLocked(values, id)) throw new Error(`${def.title} needs ${BY_ID.get(def.parent ?? '')?.title ?? def.parent} turned on first.`)
  const next = { ...values }
  // The default isn't stored, so a later change of default reaches everyone who never touched it.
  if (value === def.default) delete next[id]
  else next[id] = value
  return next
}

export interface FlagsService {
  list(): FlagState[]
  set(id: string, value: string): FlagState[]
  relaunch(): void
}
