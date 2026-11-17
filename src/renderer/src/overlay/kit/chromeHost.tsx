/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createRoot, type Root } from 'react-dom/client'
import type { OverlayDismissReason, OverlayResult, Rect, SurfaceAnchor } from '@shared/overlay'
import { intersects } from '../../ui/logic/popover'
import { holdOverlay } from '../../ui/overlay'
import type { SurfaceModule } from '../types'

// Draws an overlay surface in the chrome itself, for the time before the
// overlay host can show it above the page, and wherever the host is not
// available. It keeps the surface contract: resolve, close, reportBounds;
// one at a time; a click outside, the window losing focus and Escape close
// it. Native page views draw above the chrome, so while a card reaches over
// the page area the page is hidden (the hold), never otherwise.

export interface ChromeSurfaceOptions {
  /** The element that opened it: it shows its pressed fill while open, and a press on it closes. */
  anchorEl?: HTMLElement | null
}

interface Open {
  finish(result: OverlayResult): void
}

let current: Open | null = null
let seq = 0

function pageArea(): { left: number; top: number; width: number; height: number } | null {
  const el = document.querySelector('.workspace .content')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** The anchor in chrome CSS px; a tab anchor is relative to the page area here. */
function anchorRect(anchor: SurfaceAnchor): Rect | null {
  if (anchor.kind === 'window') return anchor.rect
  if (anchor.kind === 'point') return { x: anchor.x, y: anchor.y, width: 0, height: 0 }
  const page = pageArea()
  if (!page) return null
  const r = anchor.rect ?? { x: 0, y: 0, width: page.width, height: page.height }
  return { x: page.left + r.x, y: page.top + r.y, width: r.width, height: r.height }
}

/** True for a surface drawn here rather than in the overlay host (it sizes its own hold). */
export function inChromeHost(instanceId: string): boolean {
  return instanceId.startsWith('chrome-')
}

/** Marks the opener pressed (data-menu-open, aria-expanded) until the returned function runs. */
export function pressAnchor(el: HTMLElement | null | undefined): () => void {
  if (!el) return () => undefined
  el.setAttribute('data-menu-open', '')
  if (el.hasAttribute('aria-haspopup')) el.setAttribute('aria-expanded', 'true')
  return () => {
    el.removeAttribute('data-menu-open')
    if (el.hasAttribute('aria-haspopup')) el.setAttribute('aria-expanded', 'false')
  }
}

export function openInChrome<P>(module: SurfaceModule<P>, props: P, anchor: SurfaceAnchor, options: ChromeSurfaceOptions = {}): Promise<OverlayResult> {
  current?.finish({ instanceId: 'replaced', dismissed: 'replaced' })
  const instanceId = `chrome-${++seq}`
  const host = document.createElement('div')
  host.className = 'kit-chrome-host'
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const anchorEl = options.anchorEl ?? null
  const unpress = pressAnchor(anchorEl)
  let release: (() => void) | null = null
  const boxes = new Map<string, Rect>()

  return new Promise<OverlayResult>((resolve) => {
    let done = false
    const finish = (result: OverlayResult): void => {
      if (done) return
      done = true
      if (current === entry) current = null
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
      release?.()
      unpress()
      // Unmount after this event finishes, so a click that chose a row completes first.
      queueMicrotask(() => {
        root.unmount()
        host.remove()
      })
      if ('dismissed' in result && result.dismissed === 'escape') anchorEl?.focus({ preventScroll: true })
      resolve({ ...result, instanceId })
    }
    const dismiss = (reason: OverlayDismissReason): void => finish({ instanceId, dismissed: reason })
    const entry: Open = { finish }
    current = entry

    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (target?.closest?.('[data-kit-card]')) return
      if (anchorEl && target && anchorEl.contains(target)) {
        // A press on the anchor closes it; the click that follows must not reopen it.
        const swallow = (ev: Event): void => ev.stopPropagation()
        anchorEl.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => anchorEl.removeEventListener('click', swallow, { capture: true }), 600)
      }
      dismiss('outside')
    }
    const onKey = (e: KeyboardEvent): void => {
      // The surface handles Escape itself while it has focus; this catches it when focus is elsewhere.
      if (e.key === 'Escape' && !(e.target as Element | null)?.closest?.('[data-kit-card]')) {
        e.preventDefault()
        dismiss('escape')
      }
    }
    const onBlur = (): void => dismiss('outside')
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)

    const reportBounds = (rect: Rect, key = 'surface'): void => {
      boxes.set(key, rect)
      const page = pageArea()
      const over = !!page && [...boxes.values()].some((b) => intersects({ left: b.x, top: b.y, width: b.width, height: b.height }, page))
      if (over && !release) release = holdOverlay()
      else if (!over && release) {
        release()
        release = null
      }
    }

    const Component = module.component
    root.render(
      <Component
        instanceId={instanceId}
        props={props}
        anchor={anchor}
        windowId={0}
        resolve={(value) => finish({ instanceId, value })}
        close={() => dismiss('closed')}
        reportBounds={(rect) => reportBounds(rect)}
        exiting={false}
        anchorRect={anchorRect(anchor)}
        viewport={{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }}
        tabId={anchor.kind === 'tab' ? anchor.tabId : null}
      />,
    )
  })
}
