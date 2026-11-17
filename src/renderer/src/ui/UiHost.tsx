/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { Rect } from '@shared/overlay'
import { atelier } from '../api'
import { ConfirmHost } from './Confirm'
import { PopoverHost } from './Popover'
import { ToastHost, type ToastPlacement } from './Toast'

export interface UiHostProps {
  toastPlacement?: ToastPlacement
  /** See ToastHost: set when toasts sit over a web page. */
  toastsCoverPage?: boolean
}

/** Mount once in App: it shows useConfirm() questions, useToast() toasts and in-window popover menus. */
export function UiHost({ toastPlacement, toastsCoverPage }: UiHostProps): ReactElement {
  return (
    <>
      <ConfirmHost />
      <PopoverHost />
      <ToastHost placement={toastPlacement} coversPage={toastsCoverPage} />
      <OverlayDragGuards />
      <WindowVeil />
    </>
  )
}

/**
 * The chrome's window-drag regions win over views stacked above them, so
 * wherever an interactive overlay surface draws (a menu over the toolbar),
 * the chrome lifts its drag region. Main sends the rects.
 */
function OverlayDragGuards(): ReactElement | null {
  const [rects, setRects] = useState<Rect[]>([])
  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type === 'overlay-region') setRects(event.rects)
      }),
    [],
  )
  if (rects.length === 0) return null
  return (
    <>
      {rects.map((r, i) => (
        <div key={i} className="overlay-drag-guard" aria-hidden="true" style={{ left: r.x, top: r.y, width: r.width, height: r.height }} />
      ))}
    </>
  )
}

/**
 * While a whole-window dialog is open in the overlay, the chrome
 * blurs and washes itself (styled on `data-window-veil`), and draws stills
 * of the web pages that main hid, so they blur with everything else.
 */
function WindowVeil(): ReactElement | null {
  const [veil, setVeil] = useState<{ on: boolean; stills: { rect: Rect; src: string }[] }>({ on: false, stills: [] })
  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type === 'window-veil') setVeil({ on: event.on, stills: event.stills })
      }),
    [],
  )
  useEffect(() => {
    const root = document.documentElement
    if (veil.on) root.dataset.windowVeil = 'on'
    else delete root.dataset.windowVeil
    return () => void delete root.dataset.windowVeil
  }, [veil.on])
  if (!veil.on || veil.stills.length === 0) return null
  return (
    <div className="ui-veil-stills" aria-hidden="true">
      {veil.stills.map((s, i) => (
        <img key={i} className="ui-veil-stills__page" src={s.src} alt="" draggable={false} style={{ left: s.rect.x, top: s.rect.y, width: s.rect.width, height: s.rect.height }} />
      ))}
    </div>
  )
}
