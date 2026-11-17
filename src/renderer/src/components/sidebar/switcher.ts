/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import type { TabsSnapshot } from '@shared/ipc'
import type { RecentCard } from '@shared/overlay/tabs'
import { atelier, call } from '../../api'
import { openTabsSurface, resultValue, type OpenSurface } from '../../overlay/surfaces/tabs/open'
import { cardHost } from './cardContent'
import { useAppEvent } from './events'
import { closeCard } from './hoverCard'
import { initialSelection, recentCards, stepSelection } from './logic/switcher'

// The chrome's side of the recent-tab switcher (SH-29). Main's key-state
// machine sends `recent-tabs` phases: open, step, commit (⌃ released) and
// cancel. The chrome owns the cards and the selection; the overlay draws
// them, and the overlay's pointer and arrow picks come back through main as
// `recent-tabs-hover`. Pages never see the keys, since main handles them.

interface Open {
  cards: RecentCard[]
  selected: number
  surface: Promise<OpenSurface | null>
}

export function useRecentTabsSwitcher(snapshot: TabsSnapshot, enabled: boolean): void {
  const state = useRef<Open | null>(null)
  const snap = useRef(snapshot)
  snap.current = snapshot

  const close = (): void => {
    const open = state.current
    state.current = null
    void open?.surface.then((s) => s?.close())
  }
  const commit = (tabId?: string): void => {
    const open = state.current
    const id = tabId ?? open?.cards[open.selected]?.tabId
    close()
    if (id) void atelier.tabs.activate(id)
  }
  const select = (index: number): void => {
    const open = state.current
    if (!open) return
    open.selected = Math.max(0, Math.min(open.cards.length - 1, index))
    const props = { cards: open.cards, selected: open.selected }
    void open.surface.then((s) => s?.update(props))
  }

  useAppEvent('recent-tabs', (e) => {
    if (!enabled) return
    if (e.phase === 'open') {
      closeCard()
      close()
      void call('tabs', 'recent')
        .catch(() => [] as string[])
        .then((recent) => {
          const cards = recentCards(recent, snap.current, cardHost)
          if (cards.length < 2) return
          const selected = initialSelection(cards.length, e.delta)
          const rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
          const surface = openTabsSurface('recent-tabs', { kind: 'window', rect }, { cards, selected })
          const open: Open = { cards, selected, surface }
          state.current = open
          void surface.then((s) => {
            if (!s) return
            void s.result.then((r) => {
              if (state.current !== open) return
              const value = resultValue(r) as { commit?: unknown } | undefined
              if (typeof value?.commit === 'string') commit(value.commit)
              else state.current = null
            })
          })
          // Thumbnails follow as they come, so the switcher opens at once.
          void Promise.all(cards.map((c) => Promise.all(c.pages.map((p) => call('tabs', 'thumbnail', p.tabId).catch(() => null))))).then((thumbs) => {
            if (state.current !== open) return
            open.cards = cards.map((c, i) => ({ ...c, pages: c.pages.map((p, j) => ({ ...p, thumbnail: thumbs[i]?.[j] ?? null })) }))
            select(open.selected)
          })
        })
    } else if (e.phase === 'step') {
      const open = state.current
      if (open) select(stepSelection(open.selected, e.delta, open.cards.length))
    } else if (e.phase === 'commit') {
      if (state.current) commit()
    } else {
      close()
    }
  })
  useAppEvent('recent-tabs-hover', (e) => select(e.index))

  // Window blur reaches the switcher through main's key-state machine (cancel) and the overlay's own policy; unmounting closes it too.
  useEffect(() => () => close(), [])
}
