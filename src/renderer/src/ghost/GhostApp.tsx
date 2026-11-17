/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import type { TabGhost } from '@shared/tabs'
import { Globe } from 'lucide-react'
import { ghostLayout } from './logic'
import './ghost.css'

// The tear-off ghost (SH-30): a click-through window main moves with the
// pointer while a tab is dragged out of its list. Near the list it is a chip
// with the favicon and title; further away it grows into a card with the
// page's thumbnail. Over the pinned grid it morphs into a pinned tile, the
// favicon alone (DS-16). Main sizes the window; this draws into it.

export function GhostApp(): ReactElement | null {
  const [ghost, setGhost] = useState<TabGhost | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(
    () =>
      window.apex.onAppEvent((event) => {
        if (event.type !== 'tab-ghost') return
        setGhost(event.ghost)
        setBroken(false)
      }),
    [],
  )
  if (!ghost) return null
  const layout = ghostLayout(ghost.grow, ghost.tile ?? 0)
  const style = { '--ghost-thumb': layout.thumbOpacity, '--ghost-radius': `${layout.radius}px`, '--ghost-title': layout.titleOpacity } as CSSProperties
  return (
    <div className={layout.tile ? 'ghost ghost--tile' : 'ghost'} style={style} aria-hidden>
      {ghost.thumbnail && layout.thumbOpacity > 0 && <img className="ghost__thumb" src={ghost.thumbnail} alt="" draggable={false} />}
      <div className="ghost__chip">
        {ghost.favicon && !broken ? (
          <img className="ghost__favicon" src={ghost.favicon} alt="" width={16} height={16} draggable={false} onError={() => setBroken(true)} />
        ) : (
          <Globe className="ghost__favicon" size={16} aria-hidden />
        )}
        <span className="ghost__title">{ghost.title}</span>
      </div>
    </div>
  )
}
