/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CONNECTOR_CATEGORIES, DIRECTORY_ID, type DirectoryEntry } from '@shared/connectors'
import entries from './directory.json'

// The curated connector directory (SK-13): official remote MCP
// endpoints from each vendor's own docs, described in Atelier's words and
// grouped in Atelier's categories. No logos ship with it: icons are favicons
// fetched at runtime, or Atelier's generic category icons.

export type DirectoryProblem = { id: string; problem: string }

/** Every rule an entry must meet; the unit test runs this over directory.json. */
export function directoryProblems(list: readonly DirectoryEntry[]): DirectoryProblem[] {
  const problems: DirectoryProblem[] = []
  const seen = new Set<string>()
  for (const e of list) {
    const add = (problem: string): void => void problems.push({ id: e.id, problem })
    if (!DIRECTORY_ID.test(e.id)) add('id format')
    if (seen.has(e.id)) add('duplicate id')
    seen.add(e.id)
    if (!(CONNECTOR_CATEGORIES as readonly string[]).includes(e.category)) add('unknown category')
    for (const url of [e.url, e.docsUrl]) {
      try {
        if (new URL(url).protocol !== 'https:') add(`not https: ${url}`)
      } catch {
        add(`bad url: ${url}`)
      }
    }
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(e.site)) add('site must be a bare host name')
    if (!e.description || e.description.length > 90) add('description length')
    if (e.setup === 'google' && !e.fields?.some((f) => f.key === 'clientId')) add('google setup needs a clientId field')
    if (!['oauth', 'token', 'none'].includes(e.auth)) add('auth')
  }
  return problems
}

export const DIRECTORY: readonly DirectoryEntry[] = (entries as DirectoryEntry[]).filter((e) => directoryProblems([e]).length === 0)

export function directoryEntry(id: string): DirectoryEntry | undefined {
  return DIRECTORY.find((e) => e.id === id)
}
