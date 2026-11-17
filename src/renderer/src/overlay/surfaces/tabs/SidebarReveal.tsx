/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import { SIDEBAR_WIDTH } from '@shared/ipc'
import { CompanionsContext } from '../../../components/shellContext'
import { Sidebar } from '../../../components/sidebar/Sidebar'
import { useLatest } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { useShellData } from './useShellData'

// Edge reveal (SH-04): while the sidebar is hidden, reaching the window's
// left edge floats it over the page in the overlay. It goes again once the
// pointer is over anything else. The overlay renderer has no App, so it loads
// the sidebar's data itself.

export function SidebarReveal({ close }: SurfaceComponentProps<Record<string, never>>): ReactElement {
  const data = useShellData()
  const width = Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, data.settings.sidebarWidth))
  const zone = useRef<HTMLDivElement>(null)
  const latestClose = useLatest(close)
  // The zone runs from the window's edge, so a pointer resting there (or the sidebar sliding in past it)
  // never counts as leaving. Leaving the window doesn't either: the pointer may stop just past its edge,
  // where main still reveals. Moving over anything else in the window, it goes. Only a real move counts:
  // when the view appears under a still pointer, macOS sends a move there with no movement.
  useEffect(() => {
    let closed = false
    const onMove = (e: PointerEvent): void => {
      if (closed || (e.movementX === 0 && e.movementY === 0) || zone.current?.contains(e.target as Node)) return
      closed = true
      latestClose.current?.()
    }
    document.addEventListener('pointermove', onMove)
    return () => document.removeEventListener('pointermove', onMove)
  }, [latestClose])
  return (
    <CompanionsContext.Provider value={data.companions}>
      <div ref={zone} className="sidebar-reveal-zone">
        <div className="sidebar-reveal" style={{ width }}>
          <Sidebar
            snapshot={data.snapshot}
            chats={data.chats}
            routines={data.routines}
            settings={data.settings}
            bookmarks={data.bookmarks}
            downloads={data.downloads}
            sidebarOpen={data.windowState.sidebarOpen}
            hidden={false}
            width={width}
            resizing={false}
            trafficLights={false}
            floating
            onWidth={() => undefined}
            onWidthCommit={() => undefined}
          />
        </div>
      </div>
    </CompanionsContext.Provider>
  )
}
