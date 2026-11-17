/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { TabsSnapshot } from '@shared/ipc'
import { isBlankUrl, isInternalUrl } from '@shared/url'
import { call } from '../api'
import { onTabsChanged, tabsSnapshot } from './liveTabs'

// Web pages are native views above the chrome, and the card's overlay hold
// hides them. So the card first takes a still of each website on show and
// draws it where the page was, under the wash, which pales and blurs it.
// Only the content area is washed; the sidebar and toolbar stay sharp.
// Apex pages are drawn by the chrome itself and need no still.

/** How long the card waits for stills before it opens anyway. */
const SNAPSHOT_WAIT_MS = 350

export interface PageShot {
  url: string
  /** In viewport px; the layer subtracts its own offset. */
  rect: { left: number; top: number; width: number; height: number }
  radius: string
}

/**
 * The page panes, primary first. App marks them with data-page-pane; the
 * class is the fallback for layouts that don't yet.
 */
function paneElements(): HTMLElement[] {
  const marked = [...document.querySelectorAll<HTMLElement>('[data-page-pane]')]
  if (marked.length > 0) return marked.sort((a, b) => (a.dataset.pagePane === 'secondary' ? 1 : 0) - (b.dataset.pagePane === 'secondary' ? 1 : 0))
  return [...document.querySelectorAll<HTMLElement>('.pane__view')]
}

function shownIds(snapshot: TabsSnapshot): string[] {
  return snapshot.split ? [snapshot.split.primaryId, snapshot.split.secondaryId] : snapshot.activeId ? [snapshot.activeId] : []
}

async function takeShots(snapshot: TabsSnapshot): Promise<PageShot[]> {
  const panes = paneElements()
  const jobs = shownIds(snapshot).map(async (id, i): Promise<PageShot | null> => {
    const tab = snapshot.tabs.find((t) => t.id === id)
    const pane = panes[i]
    if (!tab || !pane || isInternalUrl(tab.url) || isBlankUrl(tab.url)) return null
    const r = pane.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return null
    const url = await call('pages', 'snapshot', id).catch(() => null)
    const radius = getComputedStyle(pane).borderRadius || getComputedStyle(pane.parentElement ?? pane).borderRadius
    return url ? { url, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, radius } : null
  })
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_WAIT_MS))
  const shots = await Promise.race([Promise.all(jobs), timeout])
  return (shots ?? []).filter((s): s is PageShot => s !== null)
}

/**
 * Takes the stills before the card shows; `ready` turns true when they're in
 * (or the wait ran out). The chrome stays usable under the card, so a
 * different tab brought forward gets its own still. Off (a card filling a
 * chat column hides no page) it is ready at once with no stills.
 */
export function usePageStills(enabled: boolean): { ready: boolean; shots: PageShot[] } {
  const [state, setState] = useState<{ ready: boolean; shots: PageShot[] }>({ ready: !enabled, shots: [] })
  useEffect(() => {
    if (!enabled) return
    let live = true
    let shown = shownIds(tabsSnapshot()).join(' ')
    void takeShots(tabsSnapshot()).then((shots) => live && setState({ ready: true, shots }))
    const stop = onTabsChanged((snapshot) => {
      const next = shownIds(snapshot).join(' ')
      if (next === shown) return
      shown = next
      void takeShots(snapshot).then((shots) => live && setState({ ready: true, shots }))
    })
    return () => {
      live = false
      stop()
    }
  }, [enabled])
  return state
}

/** The stills, placed relative to the layer at `origin` (its viewport offset). */
export function PageStills({ shots, origin }: { shots: PageShot[]; origin: { left: number; top: number } }): ReactElement | null {
  if (shots.length === 0) return null
  return (
    <div className="co-stills" aria-hidden="true">
      {shots.map((shot, i) => (
        <img
          key={`${i}-${shot.url.length}`}
          src={shot.url}
          alt=""
          draggable={false}
          style={{ left: shot.rect.left - origin.left, top: shot.rect.top - origin.top, width: shot.rect.width, height: shot.rect.height, borderRadius: shot.radius }}
        />
      ))}
    </div>
  )
}
