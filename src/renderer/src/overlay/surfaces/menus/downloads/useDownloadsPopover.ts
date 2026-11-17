/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { fileKind, popoverProps, type Point } from '@shared/downloads'
import type { DownloadInfo } from '@shared/services'
import { apex, call } from '../../../../api'
import { motionReduced, useLatest } from '../../../../ui'
import { anchorFromElement } from '../../../useSurface'

// The chrome's side of the downloads popover (OV-17 to OV-19), used by the
// downloads button in the sidebar header and the horizontal toolbar. A click
// toggles the popover; a `download-started` event can open it by itself and
// fly the file's icon into the button. While the overlay host isn't
// available the button opens the Downloads page instead.

interface Cue {
  id: string
  autoOpen: boolean
  byAgent: boolean
  at: number
}

/** A cue waits this long for a visible downloads button (the list event can render it a frame later). */
const CUE_TTL_MS = 3000

const cues: Cue[] = []
const cueListeners = new Set<() => void>()
let listening = false

function listenForCues(): void {
  if (listening) return
  listening = true
  apex.onAppEvent((event) => {
    if (event.type !== 'download-started') return
    cues.push({ id: event.id, autoOpen: event.autoOpen, byAgent: event.byAgent, at: Date.now() })
    for (const listener of cueListeners) listener()
  })
}

function takeCues(): Cue[] {
  const now = Date.now()
  const fresh = cues.filter((c) => now - c.at < CUE_TTL_MS)
  cues.length = 0
  return fresh
}

/** Shown on screen: laid out, and not inside the hidden (inert) sidebar. */
function isShown(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && el.closest('[inert]') === null
}

function centre(r: DOMRect): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Flies the file's icon from the page to the button; skipped under reduced motion (OV-19). */
function fly(button: HTMLElement, cue: Cue, downloads: readonly DownloadInfo[]): void {
  if (motionReduced() || document.hidden) return
  const d = downloads.find((x) => x.id === cue.id)
  const page = document.querySelector<HTMLElement>('.pane__view')?.getBoundingClientRect()
  const from = page && page.width > 0 && page.height > 0 ? { x: page.left + page.width / 2, y: page.top + page.height * 0.4 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const anchor = { kind: 'window' as const, rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } }
  void apex.overlay.open('download-flight', anchor, { from, to: centre(button.getBoundingClientRect()), kind: d ? fileKind(d.filename, d.mime) : 'file' }).catch(() => undefined)
}

export interface DownloadsPopoverControl {
  open: boolean
  toggle(): void
}

export function useDownloadsPopover(anchor: RefObject<HTMLElement | null>, downloads: DownloadInfo[]): DownloadsPopoverControl {
  const [open, setOpen] = useState(false)
  const instance = useRef<string | null>(null)
  const opening = useRef(false)
  /** Bumped by every close, so an open that resolves after it is closed again. */
  const generation = useRef(0)
  const latest = useLatest(downloads)
  const props = useMemo(() => popoverProps(downloads), [downloads])

  const show = useCallback(async (fromClick: boolean): Promise<void> => {
    const el = anchor.current
    if (!el || instance.current || opening.current) return
    opening.current = true
    const gen = ++generation.current
    setOpen(true)
    try {
      const { instanceId } = await apex.overlay.open('downloads', anchorFromElement(el), popoverProps(latest.current))
      if (gen !== generation.current) apex.overlay.close(instanceId)
      else instance.current = instanceId
    } catch {
      setOpen(false)
      if (fromClick && gen === generation.current) void call('pages', 'open', 'apex://downloads')
    } finally {
      opening.current = false
    }
  }, [])

  const hide = useCallback((): void => {
    const id = instance.current
    generation.current++
    instance.current = null
    setOpen(false)
    if (id) apex.overlay.close(id)
  }, [])

  // Esc, an outside click or a row's action closes it from the overlay side.
  useEffect(
    () =>
      apex.overlay.onResult((r) => {
        if (r.instanceId !== instance.current) return
        instance.current = null
        setOpen(false)
      }),
    [],
  )

  useEffect(() => {
    if (instance.current) apex.overlay.update(instance.current, props)
  }, [props])

  useEffect(() => () => hide(), [])

  // New downloads: fly the icon in and, when OV-18 says so, open the popover.
  const consume = useCallback((): void => {
    const el = anchor.current
    // Hidden buttons leave cues for the visible one (sidebar or toolbar).
    if (!el || !isShown(el) || cues.length === 0) return
    for (const cue of takeCues()) {
      if (!cue.byAgent) fly(el, cue, latest.current)
      if (cue.autoOpen) void show(false)
    }
  }, [])

  useEffect(() => {
    listenForCues()
    cueListeners.add(consume)
    return () => {
      cueListeners.delete(consume)
    }
  }, [])

  // The button renders once the list has a row; pick up the cue that came with it.
  useEffect(() => {
    const frame = requestAnimationFrame(consume)
    return () => cancelAnimationFrame(frame)
  }, [downloads])

  return { open, toggle: () => (instance.current || opening.current ? hide() : void show(true)) }
}
