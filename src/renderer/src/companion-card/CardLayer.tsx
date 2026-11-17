/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ModalScope, cx, useLatest, useOverlay } from '../ui'
import { hasOpenLayer, tabbables } from '../ui/layers'
import { trapFocusIndex } from '../ui/logic/keys'
import { PageStills, type PageShot } from './Backdrop'

// The companion card's own layer. Unlike a Modal it covers only the content
// area (or the chat column it was opened from), so the sidebar, toolbar and
// bookmarks bar stay sharp and usable. Inside, it still behaves like a
// dialog: focus moves in, Tab cycles within it, Esc and a click on the
// washed page close it, and focus goes back to the opener.

/** 'page' is an apex://companion tab: the same card drawn as the whole content area (DS-121). */
export type CardMode = 'float' | 'column' | 'page'

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** Where a chat column says "fill me": anything that opts in, else the side panel itself. */
const COLUMN = ['[data-card-column]', '.chat-panel']
/** The content area, from the most to the least specific hook. */
const REGION = ['[data-card-region]', '.workspace', '.content']

// The opener is whatever was pressed or focused just before the card
// mounted; buttons aren't always focused by a click, so presses are tracked.
let lastPress: { target: Element; at: number } | null = null
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target instanceof Element) lastPress = { target: e.target, at: performance.now() }
  },
  true,
)

function currentOpener(): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) return active
  const press = lastPress && performance.now() - lastPress.at < 1500 ? lastPress.target : null
  return press instanceof HTMLElement ? press : (press?.parentElement ?? null)
}

function toRect(r: DOMRect): Rect {
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

function regionElement(): HTMLElement | null {
  for (const selector of REGION) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el) return el
  }
  return null
}

export interface CardPlacement {
  mode: CardMode
  rect: Rect
  /** Focus goes back here on close. */
  opener: HTMLElement | null
  /** The column's corner radius, so a card filling it matches its shape. */
  radius: string | null
}

/**
 * Where the card goes: filling the chat column it was opened from, floating
 * over the content area, or (`asPage`) filling the content area as its own
 * tab. Kept in step with the region's size.
 */
export function useCardPlacement(asPage = false): CardPlacement {
  const [start] = useState(() => {
    const opener = currentOpener()
    const column = COLUMN.map((selector) => opener?.closest<HTMLElement>(selector) ?? null).find((el) => el !== null) ?? null
    return { opener, column }
  })
  const pick = (): { el: HTMLElement | null; mode: CardMode } =>
    asPage ? { el: regionElement(), mode: 'page' } : start.column?.isConnected ? { el: start.column, mode: 'column' } : { el: regionElement(), mode: 'float' }
  const measure = (): Omit<CardPlacement, 'opener'> => {
    const { el, mode } = pick()
    const rect = el ? toRect(el.getBoundingClientRect()) : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    return { mode, rect, radius: mode === 'column' && el ? getComputedStyle(el).borderRadius : null }
  }
  const [placement, setPlacement] = useState(measure)

  useLayoutEffect(() => {
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = measure()
        setPlacement((p) =>
          p.mode === next.mode && p.radius === next.radius && p.rect.left === next.rect.left && p.rect.top === next.rect.top && p.rect.width === next.rect.width && p.rect.height === next.rect.height ? p : next,
        )
      })
    }
    const observer = new ResizeObserver(update)
    const watched = pick().el
    if (watched) observer.observe(watched)
    window.addEventListener('resize', update)
    // The region can also move without resizing; a slow check catches that.
    const slow = setInterval(update, 500)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
      clearInterval(slow)
    }
  }, [])

  return { ...placement, opener: start.opener }
}

export interface CardLayerProps {
  placement: CardPlacement
  shots: PageShot[]
  /** The exit is playing; the layer stays inert until it unmounts. */
  leaving: boolean
  labelledBy: string
  /** Esc, unless something inside the card used it first. */
  onEscape(): void
  /** A click on the washed page. */
  onDismiss(): void
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function CardLayer({ placement, shots, leaving, labelledBy, onEscape, onDismiss, className, style, children }: CardLayerProps): ReactElement {
  const layer = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const pressedWash = useRef(false)
  const escape = useLatest(onEscape)
  const opener = useLatest(placement.opener)
  // A card filling a chat column covers no page, so the page views stay.
  useOverlay(placement.mode === 'float')

  useLayoutEffect(() => {
    // The panel itself takes focus, so no ring shows until the keyboard is used.
    const target = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current
    target?.focus({ preventScroll: true })
    return () => {
      const back = opener.current
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || hasOpenLayer()) return
      const active = document.activeElement
      // Esc in the toolbar or sidebar belongs to them.
      if (active && active !== document.body && !layer.current?.contains(active)) return
      e.preventDefault()
      escape.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || e.defaultPrevented || !panel.current?.contains(e.target as Node)) return
    const items = tabbables(panel.current)
    if (!items.length) {
      e.preventDefault()
      panel.current.focus()
      return
    }
    const current = items.indexOf(document.activeElement as HTMLElement)
    const atEdge = current === -1 || (e.shiftKey ? current === 0 : current === items.length - 1)
    if (!atEdge) return
    e.preventDefault()
    items[trapFocusIndex(current, items.length, e.shiftKey)]?.focus()
  }

  const { rect, mode } = placement
  return createPortal(
    <div
      ref={layer}
      className={cx('co-layer', `co-layer--${mode}`, leaving && 'co-layer--leaving')}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      inert={leaving || undefined}
      onKeyDown={onKeyDown}
    >
      {mode === 'float' && <PageStills shots={shots} origin={rect} />}
      {mode === 'float' && (
        <div
          className="co-wash"
          aria-hidden
          onPointerDown={(e) => {
            pressedWash.current = e.target === e.currentTarget
          }}
          onClick={(e) => {
            // Only a press that started on the wash closes, not a drag out of the card.
            if (pressedWash.current && e.target === e.currentTarget) onDismiss()
            pressedWash.current = false
          }}
        />
      )}
      <div
        ref={panel}
        role="dialog"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cx('co-card', `co-card--${mode}`, className)}
        style={{ ...style, ...(placement.radius ? ({ '--co-column-radius': placement.radius } as CSSProperties) : null) }}
      >
        {/* DS-29: dialogs opened from the card wash only the content area, like the card. */}
        <ModalScope scope="content">{children}</ModalScope>
      </div>
    </div>,
    document.body,
  )
}
