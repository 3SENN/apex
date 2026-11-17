/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { SHARED_OWNER } from '@shared/chats'
import type { TabInfo } from '@shared/ipc'
import type { Connector, Skill } from '@shared/services'
import { isInternalUrl } from '@shared/url'
import { apex, call } from '../../api'

// What the + menu and the @ list offer, read from the live stores: the
// connectors (loaded once, then followed), the web pages that are open, and
// the skills a companion may use.

let connectors: Connector[] | null = null
let started = false
const listeners = new Set<() => void>()

function start(): void {
  if (started) return
  started = true
  apex.onAppEvent((e) => {
    if (e.type !== 'connectors') return
    connectors = e.items
    for (const fn of [...listeners]) fn()
  })
  void call('connectors', 'list').then(
    (items) => {
      connectors = items
      for (const fn of [...listeners]) fn()
    },
    () => {
      connectors = []
      for (const fn of [...listeners]) fn()
    },
  )
}

/** Connectors that are on and belong to this companion (or every companion); null while loading. */
export function useConnectorList(companionId: string): Connector[] | null {
  const all = useSyncExternalStore(
    (fn) => {
      start()
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => connectors,
  )
  return all ? all.filter((c) => c.enabled && (c.owner === SHARED_OWNER || c.owner === companionId)) : null
}

/** Open web pages, most recently used first: Apex's own pages and blank tabs can't be attached. */
export function webTabs(tabs: readonly TabInfo[]): TabInfo[] {
  return tabs.filter((t) => /^https?:/.test(t.url) && !isInternalUrl(t.url)).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/** The companion's own skills first, then shared ones; other companions' skills never show. */
export function skillsFor(skills: readonly Skill[], companionId: string): Skill[] {
  const byName = (a: Skill, b: Skill): number => a.name.localeCompare(b.name)
  const own = skills.filter((s) => s.owner === companionId).sort(byName)
  const names = new Set(own.map((s) => s.name))
  const shared = skills.filter((s) => s.owner === SHARED_OWNER && !names.has(s.name)).sort(byName)
  return [...own, ...shared]
}
