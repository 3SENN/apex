/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'
import type { SidebarOptions } from '@shared/ipc'
import { openTabsSurface, type OpenSurface } from '../../overlay/surfaces/tabs/open'
import { useAppEvent } from './events'
import { closeCard } from './hoverCard'

// The sidebar's overlay surfaces: the edge reveal (SH-04) floats the whole
// sidebar over the page while it is hidden, and the options popover (SH-09)
// is drawn in the overlay above the page.

function windowRect(): { x: number; y: number; width: number; height: number } {
  return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
}

/** While the sidebar is hidden, reaching the window's edge floats it over the page; it goes once the pointer is over the page. */
export function useEdgeReveal(enabled: boolean): void {
  const open = useRef<Promise<OpenSurface | null> | null>(null)
  useAppEvent('edge-reveal', (e) => {
    if (!enabled || !e.active || open.current) return
    closeCard()
    const surface = openTabsSurface('sidebar-reveal', { kind: 'window', rect: windowRect() }, {})
    open.current = surface
    void surface.then((s) => {
      if (!s) {
        open.current = null
        return
      }
      void s.result.then(() => {
        if (open.current === surface) open.current = null
      })
    })
  })
  // Showing the sidebar again (or leaving the layout) puts the floating one away.
  useEffect(() => {
    if (enabled || !open.current) return
    const surface = open.current
    open.current = null
    void surface.then((s) => s?.close())
  }, [enabled])
}

/**
 * The options popover under its header button. Resolves false when the
 * overlay isn't available, so the caller shows its inline panel instead.
 */
export function useOptionsSurface(options: SidebarOptions, onClosed: () => void): { open(anchor: Element): Promise<boolean>; close(): void; isOpen(): boolean } {
  const current = useRef<OpenSurface | null>(null)
  const latest = useRef(options)
  latest.current = options
  const closed = useRef(onClosed)
  closed.current = onClosed
  useEffect(() => {
    current.current?.update({ options })
  }, [options])
  useEffect(() => () => current.current?.close(), [])
  return {
    open: async (anchor) => {
      if (current.current) return true
      const r = anchor.getBoundingClientRect()
      const s = await openTabsSurface('sidebar-options', { kind: 'window', rect: { x: r.left, y: r.top, width: r.width, height: r.height } }, { options: latest.current })
      if (!s) return false
      current.current = s
      void s.result.then(() => {
        if (current.current === s) current.current = null
        closed.current()
      })
      return true
    },
    close: () => current.current?.close(),
    isOpen: () => current.current !== null,
  }
}
