/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState, type DragEvent, type PointerEvent, type ReactElement } from 'react'
import type { SplitZonesProps } from '@shared/overlay/tabs'
import { splitReachAt, splitSideAt, type SplitSide } from '@shared/tabs'
import { call } from '../../../api'
import { ENTRY_DRAG_TYPE } from '../../../components/sidebar/dnd'
import { useT } from '../../../i18n/useT'
import { cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'

// The split zones over the content card during a tab drag (SH-30): left and
// right zones that pull toward the pointer and grow as it nears an edge.
// While the view can't split (already split, the companion is working there,
// a chat is replying) they show why instead. They are the drop target over
// the page, so the page never gets the drop: the drop says which side, the
// one last shown, and main splits there.

export function SplitZones({ props }: SurfaceComponentProps<SplitZonesProps>): ReactElement {
  const t = useT()
  const reason = props.block === 'already-split' ? t('tabs.zones.alreadySplit') : props.block === 'agent' ? t('tabs.zones.agent') : props.block === 'replying' ? t('tabs.zones.replying') : null
  // The zones' own read of the pointer, once dragovers reach them; main's props until then.
  const [own, setOwn] = useState<{ active: SplitSide | null; reach: number } | null>(null)
  const seen = useRef(false)
  const done = useRef(false)
  const read = (e: DragEvent<HTMLDivElement>): { active: SplitSide | null; reach: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - r.left) / Math.max(1, r.width)
    return { active: reason === null ? splitSideAt(x) : null, reach: splitReachAt(x) }
  }
  /** A dragged entry (only tab drags open the zones) is accepted here; anything else (a link, a file) passes. */
  const accept = (e: DragEvent<HTMLDivElement>): boolean => {
    if (!e.dataTransfer.types.includes(ENTRY_DRAG_TYPE)) return false
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    return true
  }
  const onOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!accept(e)) return
    if (!seen.current) {
      seen.current = true
      void call('tabDrag', 'zonesSeen', props.session).catch(() => undefined)
    }
    const next = read(e)
    setOwn((prev) => (prev && prev.active === next.active && Math.abs(prev.reach - next.reach) < 0.02 ? prev : next))
  }
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!accept(e) || done.current) return
    done.current = true
    void call('tabDrag', 'dropOnZone', props.session, read(e).active).catch(() => undefined)
  }
  // Pointer events only come back once a drag is over: a real move with no button down means it ended
  // without a word to main (its dragend got lost), so it ends here as a cancel, never as a drop.
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (done.current || e.buttons !== 0 || (e.movementX === 0 && e.movementY === 0)) return
    done.current = true
    void call('tabDrag', 'cancel').catch(() => undefined)
  }
  const active = own ? own.active : props.active
  const reach = own ? own.reach : props.reach
  return (
    <div
      className={cx('split-zones', reason !== null && 'split-zones--blocked')}
      style={{ ['--zone-reach' as string]: reach }}
      aria-hidden
      onDragEnter={onOver}
      onDragOver={onOver}
      onDrop={onDrop}
      onPointerMove={onPointerMove}
    >
      {reason !== null ? (
        <div className="split-zones__reason">{reason}</div>
      ) : (
        (['left', 'right'] as const).map((side) => (
          <div key={side} className={cx('split-zone', `split-zone--${side}`, active === side && 'split-zone--active')}>
            <span className="split-zone__label">{side === 'left' ? t('tabs.zones.left') : t('tabs.zones.right')}</span>
          </div>
        ))
      )}
    </div>
  )
}
