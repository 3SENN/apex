/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState, type DragEvent, type PointerEvent } from 'react'
import { call } from '../../api'
import { droppedText, hasDroppable, pointInside } from './logic/drops'
import { dropIndex } from './logic/order'
import type { TabDragZone } from '@shared/tabs'

// Drag and drop between the sidebar's typed zones. Each entry kind declares
// the zones it may enter: tabs go to the pinned grid and the tab list, chats
// stay in the Chats section. Native HTML drag events keep this light.

export type EntryKind = 'tab' | 'chat'
export type Zone = 'pinned' | 'tabs' | 'chats'

export interface DragEntry {
  kind: EntryKind
  id: string
}

const ZONES: Record<EntryKind, readonly Zone[]> = {
  tab: ['pinned', 'tabs'],
  chat: ['chats'],
}

export function accepts(zone: Zone, entry: DragEntry | null): boolean {
  return entry !== null && ZONES[entry.kind].includes(zone)
}

/** The drag data type of a dragged tab or chat: the overlay's split zones accept it too. */
export const ENTRY_DRAG_TYPE = 'application/x-apex-entry'
// dragover can't read dataTransfer contents, so the entry is kept here too.
let current: DragEntry | null = null
/** Set when a list took the drop, so the tear-off knows it was only a reorder (SH-30). */
let droppedOnList = false
/** DS-16: what main was last told about the pinned grid, so it hears only changes. */
let reportedZone: TabDragZone | null = null

/** Tells main the dragged tab is over the pinned grid (its ghost morphs into a tile) or has left it. */
function reportZone(zone: TabDragZone | null): void {
  if (current?.kind !== 'tab' || zone === reportedZone) return
  reportedZone = zone
  void call('tabDrag', 'over', zone).catch(() => undefined)
}

// A blank drag image: main's ghost window draws the dragged tab instead,
// growing from a chip into a thumbnail as it leaves the list.
let blankImage: HTMLImageElement | null = null
function blank(): HTMLImageElement {
  if (!blankImage) {
    blankImage = new Image()
    blankImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }
  return blankImage
}

function listRect(el: Element | null): { x: number; y: number; width: number; height: number } | null {
  const list = el?.closest('[data-tear-list]')
  if (!list) return null
  const r = list.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

function clearDrag(): void {
  current = null
  droppedOnList = false
  reportedZone = null
  document.documentElement.classList.remove('is-dragging-entry')
  window.removeEventListener('pointermove', endIfStale, true)
}

// A row React removes mid-drag never hears its dragend. Pointer events only come back once a drag is
// over, so a real move with no button down ends a tab drag still open here as a cancel, never as a drop.
function endIfStale(e: globalThis.PointerEvent): void {
  if (e.buttons !== 0 || (e.movementX === 0 && e.movementY === 0) || current?.kind !== 'tab') return
  clearDrag()
  void call('tabDrag', 'cancel').catch(() => undefined)
}

export function currentDrag(): DragEntry | null {
  return current
}

/** Props for a draggable row. Buttons and fields inside it never start a drag. */
export function useDragSource(entry: DragEntry, enabled = true): {
  draggable: boolean
  onPointerDownCapture(e: PointerEvent): void
  onDragStart(e: DragEvent): void
  onDragEnd(): void
} {
  const blocked = useRef(false)
  return {
    draggable: enabled,
    onPointerDownCapture: (e) => {
      blocked.current = e.target instanceof Element && e.target.closest('button, input, textarea, select, [contenteditable="true"]') !== null
    },
    onDragStart: (e) => {
      if (blocked.current || !enabled) {
        e.preventDefault()
        return
      }
      current = entry
      droppedOnList = false
      reportedZone = null
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(ENTRY_DRAG_TYPE, JSON.stringify(entry))
      document.documentElement.classList.add('is-dragging-entry')
      if (entry.kind === 'tab') {
        // Tabs can leave the list (tear-off): main follows the pointer from here.
        e.dataTransfer.setDragImage(blank(), 0, 0)
        window.addEventListener('pointermove', endIfStale, true)
        void call('tabDrag', 'start', entry.id, listRect(e.currentTarget)).catch(() => undefined)
      }
    },
    onDragEnd: () => {
      const tab = current?.kind === 'tab'
      const onList = droppedOnList
      clearDrag()
      if (tab) void call('tabDrag', 'end', onList).catch(() => undefined)
    },
  }
}

/**
 * A drop zone. `gap` is the row index a drop would land before (rows slide
 * apart there); `onDrop` gets the entry and that index. Rows are the zone's
 * `[data-drop-row]` children, measured on each dragover.
 */
/** Text or a link dropped from a page or another app: onto a row (`tabId`), or between rows at `index`. */
export interface TextDrop {
  text: string
  tabId: string | null
  index: number
}

/** The row under a drop of text: the tab it loads in. */
function rowUnder(target: EventTarget | null): string | null {
  const row = target instanceof Element ? target.closest<HTMLElement>('[data-drop-id]') : null
  return row?.dataset.dropId ?? null
}

export function useDropZone(
  zone: Zone,
  onDrop: (entry: DragEntry, index: number) => void,
  axis: 'y' | 'grid' = 'y',
  onText?: (drop: TextDrop) => void,
): {
  gap: number | null
  /** The row a drop of text would load in, for its highlight. */
  textTarget: string | null
  props: {
    onDragOver(e: DragEvent<HTMLElement>): void
    onDragLeave(e: DragEvent<HTMLElement>): void
    onDrop(e: DragEvent<HTMLElement>): void
  }
} {
  const [gap, setGap] = useState<number | null>(null)
  const [textTarget, setTextTarget] = useState<string | null>(null)
  const takesText = (e: DragEvent<HTMLElement>): boolean => onText !== undefined && current === null && hasDroppable(Array.from(e.dataTransfer.types))
  const indexAt = (e: DragEvent<HTMLElement>): number => {
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-drop-row]')).filter((el) => el.dataset.dropId !== current?.id)
    if (axis === 'grid') {
      // Tiles flow left to right: the first tile whose centre is past the pointer on its row.
      const i = rows.findIndex((el) => {
        const r = el.getBoundingClientRect()
        return e.clientY < r.bottom && (e.clientY < r.top || e.clientX < r.left + r.width / 2)
      })
      return i === -1 ? rows.length : i
    }
    return dropIndex(rows.map((el) => {
      const r = el.getBoundingClientRect()
      return r.top + r.height / 2
    }), e.clientY)
  }
  return {
    gap,
    textTarget,
    props: {
      onDragOver: (e) => {
        if (takesText(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          const row = rowUnder(e.target)
          setTextTarget((t) => (t === row ? t : row))
          const next = row === null ? indexAt(e) : null
          setGap((g) => (g === next ? g : next))
          return
        }
        if (!accepts(zone, current)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (zone === 'pinned') reportZone('pinned')
        const next = indexAt(e)
        setGap((g) => (g === next ? g : next))
      },
      onDragLeave: (e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        // Chromium often leaves relatedTarget null on dragleave, so moving between a zone's own
        // rows reads as leaving it; the pointer still inside the zone means it didn't leave.
        if (pointInside(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)) return
        if (zone === 'pinned') reportZone(null)
        setGap(null)
        setTextTarget(null)
      },
      onDrop: (e) => {
        const entry = current
        if (zone === 'pinned') reportZone(null)
        setGap(null)
        setTextTarget(null)
        if (takesText(e)) {
          e.preventDefault()
          const text = droppedText((type) => e.dataTransfer.getData(type))
          const tabId = rowUnder(e.target)
          if (text) onText?.({ text, tabId, index: tabId === null ? indexAt(e) : -1 })
          return
        }
        if (!entry || !accepts(zone, entry)) return
        e.preventDefault()
        droppedOnList = true
        onDrop(entry, indexAt(e))
      },
    },
  }
}
