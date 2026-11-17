/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { ChatSummary } from '@shared/chats'
import { edgeCues, type EdgeCue } from './logic/cues'
import { closeChat, initialOpenChats, openChat, parseOpenChats, reopenChats, reorderChat, syncOpenChats, type OpenChatsState } from './logic/openChats'
import { stableOrder } from './logic/order'
import { atelier, call } from '../../api'

/** After this long without pointer movement over the sidebar, held rows may reshuffle. */
export const STILL_MS = 10_000

/**
 * True while the pointer is over the element and has moved in the last
 * STILL_MS: rows sorted by activity hold still then, so nothing jumps under
 * the pointer.
 */
export function usePointerHold(ref: RefObject<HTMLElement | null>): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const release = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      setHeld(false)
    }
    const hold = (): void => {
      setHeld(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(release, STILL_MS)
    }
    el.addEventListener('pointerenter', hold)
    el.addEventListener('pointermove', hold)
    el.addEventListener('pointerleave', release)
    return () => {
      release()
      el.removeEventListener('pointerenter', hold)
      el.removeEventListener('pointermove', hold)
      el.removeEventListener('pointerleave', release)
    }
  }, [ref])
  return held
}

/** The live order, or while `held` the last shown order with new ids slotted in. */
export function useStableIds(live: readonly string[], held: boolean): string[] {
  const shown = useRef<string[]>([])
  const key = live.join('\n')
  const next = useMemo(() => (held ? stableOrder(shown.current, live) : live.slice()), [key, held])
  shown.current = next
  return next
}

const OPEN_CHATS_KEY = 'atelier.sidebar.openChats'

function loadOpenChats(): OpenChatsState {
  try {
    const raw = localStorage.getItem(OPEN_CHATS_KEY)
    return raw ? parseOpenChats(JSON.parse(raw), Date.now()) : initialOpenChats(Date.now())
  } catch {
    return initialOpenChats(Date.now())
  }
}

export interface OpenChats {
  /** Open chat ids in manual order. */
  order: string[]
  open(id: string): void
  close(id: string, lastActiveAt: number): void
  /** Undo for Clear: these chats come back on top, in this order. */
  restore(ids: readonly string[]): void
  reorder(id: string, index: number): void
}

/**
 * The Chats section's open chats, kept per profile in local storage. `chats`
 * is null until the first list arrives (the section must not seed from an
 * empty list). Chats shown as page tabs always count as open.
 */
export function useOpenChats(chats: readonly ChatSummary[] | null, chatTabIds: readonly string[]): OpenChats {
  const [state, setState] = useState(loadOpenChats)
  useEffect(() => {
    if (chats) setState((s) => syncOpenChats(s, chats))
  }, [chats])
  const tabKey = chatTabIds.join('\n')
  useEffect(() => {
    setState((s) => chatTabIds.reduce((acc, id) => openChat(acc, id), s))
  }, [tabKey])
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_CHATS_KEY, JSON.stringify(state))
    } catch {
      // Storage can be unavailable; the section still works for this session.
    }
  }, [state])
  return useMemo(
    () => ({
      order: state.order,
      open: (id: string) => setState((s) => openChat(s, id)),
      close: (id: string, lastActiveAt: number) => setState((s) => closeChat(s, id, lastActiveAt, Date.now())),
      restore: (ids: readonly string[]) => setState((s) => reopenChats(s, ids)),
      reorder: (id: string, index: number) => setState((s) => reorderChat(s, id, index)),
    }),
    [state.order],
  )
}

/**
 * True while the pointer is anywhere over the element, including when it
 * arrives straight from a page view (the chrome hears the move as soon as
 * the pointer crosses into it). The trailing stamps show only then.
 *
 * DS-14: main tracks it too. On entering, the chrome hands main the
 * element's rect; main watches the cursor and says when it has left, which
 * covers a leave the DOM never hears (straight into a native page view, onto
 * an overlay). A later move inside re-arms it.
 */
export function usePointerInside(ref: RefObject<HTMLElement | null>): boolean {
  const [inside, setInside] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let armed: { x: number; y: number; width: number; height: number } | null = null
    const report = (rect: typeof armed): void => {
      void call('window', 'trackSidebarPointer', rect).catch(() => undefined)
    }
    const enter = (): void => {
      setInside(true)
      // A resize or slide moves the rect: main gets the new one, so it never sees a false leave.
      const r = el.getBoundingClientRect()
      const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      if (armed && armed.x === rect.x && armed.y === rect.y && armed.width === rect.width && armed.height === rect.height) return
      armed = rect
      report(rect)
    }
    const leave = (): void => {
      setInside(false)
      if (!armed) return
      armed = null
      report(null)
    }
    // Main saw the pointer leave: the DOM missed it, so drop the state without telling main back.
    const off = atelier.onAppEvent((event) => {
      if (event.type !== 'sidebar-pointer' || event.inside) return
      armed = null
      setInside(false)
    })
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointermove', enter)
    el.addEventListener('pointerleave', leave)
    // Leaving the window (or into a native page view that swallows the leave) ends it too.
    document.documentElement.addEventListener('pointerleave', leave)
    window.addEventListener('blur', leave)
    return () => {
      off()
      if (armed) report(null)
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointermove', enter)
      el.removeEventListener('pointerleave', leave)
      document.documentElement.removeEventListener('pointerleave', leave)
      window.removeEventListener('blur', leave)
    }
  }, [ref])
  return inside
}

export interface ScrollCues {
  /** Content is scrolled under the fixed header (the hairline shows, the top edge fades). */
  top: boolean
  bottom: boolean
  /** An important row (active, waiting) is out of view above or below. */
  above: EdgeCue | null
  below: EdgeCue | null
}

/** Fades at scrollable edges, and which important rows ([data-cue]) are out of view. */
export function useScrollCues(ref: RefObject<HTMLElement | null>, key: string): ScrollCues {
  const [cues, setCues] = useState<ScrollCues>({ top: false, bottom: false, above: null, below: null })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const top = el.scrollTop > 1
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
      const view = el.getBoundingClientRect()
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-cue]'), (row) => {
        const r = row.getBoundingClientRect()
        return { cue: row.dataset.cue as EdgeCue, top: r.top, bottom: r.bottom, inert: row.closest('[inert]') !== null }
      })
      const { above, below } = edgeCues(rows, view)
      setCues((c) => (c.top === top && c.bottom === bottom && c.above === above && c.below === below ? c : { top, bottom, above, below }))
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => {
      el.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [ref, key])
  return cues
}
