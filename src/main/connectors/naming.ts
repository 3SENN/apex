/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { LOCAL_TOOL_API_NAME } from '@shared/connectors'

// Names for local connector tools as the model sees them:
// `<connectorSlug>__<toolSlug>`, at most 64 of [a-zA-Z0-9_-], ordered by
// connector name and then tool name, with a 6-character hash suffix when two
// would collide. The order makes the names stable for a chat's whole life.

export interface ToolNameEntry {
  connectorId: string
  /** The connector's server name (its slug). */
  connectorName: string
  toolName: string
}

const MAX = 64
const slug = (text: string): string => text.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
const hash6 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 6)

/** Entries in their stable order, each with its API name. */
export function localToolNames<T extends ToolNameEntry>(entries: readonly T[]): (T & { apiName: string })[] {
  const sorted = entries.slice().sort((a, b) => a.connectorName.localeCompare(b.connectorName) || a.toolName.localeCompare(b.toolName) || a.connectorId.localeCompare(b.connectorId))
  const used = new Set<string>()
  return sorted.map((entry) => {
    const left = slug(entry.connectorName).slice(0, 24)
    let name = `${left}__${slug(entry.toolName)}`.slice(0, MAX)
    if (used.has(name)) {
      const suffix = `_${hash6(`${entry.connectorId}/${entry.toolName}`)}`
      name = `${name.slice(0, MAX - suffix.length)}${suffix}`
    }
    // A second collision (same hash prefix) is astronomically unlikely; count on.
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, MAX - String(n).length - 1)}_${n}`
    used.add(name)
    if (!LOCAL_TOOL_API_NAME.test(name)) throw new Error(`Bad tool name ${name}`)
    return { ...entry, apiName: name }
  })
}
