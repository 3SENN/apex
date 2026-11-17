/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { MenuItemSpec } from '@shared/menu'
import { MenuList, type PopoverItem } from './MenuList'
import { isMac } from './hooks'
import { formatShortcut } from './logic/shortcut'
import { cx } from './logic/format'
import { intersects, placePopover, type Rect } from './logic/popover'
import { holdOverlay } from './overlay'

export type { PopoverItem } from './MenuList'

// In-window popover menus (DS-94): the overflow row, the main menu, the
// card's switcher and more menus, the composer chip and + menus, the new-tab
// switcher and sidebar options. Native menus stay for context menus only.
// One opens at a time; it appears within a frame and closes at once (DS-83),
// Escape and a click outside close it and focus goes back to the anchor,
// which shows its pressed fill while it is open.

export type PopoverAnchor = Element | { x: number; y: number }

export interface PopoverMenuOptions {
  /** Accessible name of the menu. */
  label: string
  width?: number
  align?: 'start' | 'end'
  /** Gap to the anchor, in px. */
  gap?: number
  side?: 'below' | 'above'
  /** Row height in px (36 by default; 40 for rows with faces). */
  rowHeight?: number
  /** A search row at the top that filters the items as you type. */
  search?: { placeholder: string }
  /** Content above the list (the main menu's profile block and meter). */
  header?: ReactNode
  /** Muted labels, as in the overflow dropdown. */
  muted?: boolean
  className?: string
  /** Switch rows flip in place without closing; this hears each flip. */
  onToggle?(id: string, next: boolean): void
}

interface Request {
  items: PopoverItem[]
  options: PopoverMenuOptions
  anchor: PopoverAnchor
  resolve(id: string | null): void
}

let current: Request | null = null
let version = 0
const listeners = new Set<() => void>()

function publish(next: Request | null): void {
  current = next
  version++
  for (const listener of listeners) listener()
}

function setAnchorOpen(anchor: PopoverAnchor, open: boolean): void {
  if (!(anchor instanceof Element)) return
  if (open) anchor.setAttribute('data-menu-open', '')
  else anchor.removeAttribute('data-menu-open')
  if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', String(open))
}

/**
 * Opens an in-window menu under (or above) `anchor` and resolves to the
 * chosen item's id, or null when it was dismissed. Opening another menu
 * dismisses this one.
 */
export function showPopoverMenu(items: PopoverItem[], anchor: PopoverAnchor, options: PopoverMenuOptions): Promise<string | null> {
  current?.resolve(null)
  return new Promise((resolve) => {
    const request: Request = {
      items,
      options,
      anchor,
      resolve: (id) => {
        if (current !== request) return
        setAnchorOpen(anchor, false)
        publish(null)
        resolve(id)
      },
    }
    setAnchorOpen(anchor, true)
    publish(request)
  })
}

/** Closes the open popover, if any, as dismissed. */
export function closePopover(): void {
  current?.resolve(null)
}

export function isPopoverOpen(): boolean {
  return current !== null
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The stacking level a popover needs to draw above whatever holds its anchor:
 * a menu opened from the floating companion card or a modal sits above that
 * layer, not under it. Null keeps the default popover level.
 */
export function liftedZIndex(anchor: PopoverAnchor): number | null {
  if (typeof Element === 'undefined' || !(anchor instanceof Element)) return null
  let top = 0
  for (let el: Element | null = anchor; el; el = el.parentElement) {
    const z = Number.parseInt(getComputedStyle(el).zIndex, 10)
    if (Number.isFinite(z) && z > top) top = z
  }
  const base = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--z-popover'), 10)
  return top >= (Number.isFinite(base) ? base : 0) ? top + 1 : null
}

function anchorRect(anchor: PopoverAnchor): Rect {
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }
  return { left: anchor.x, top: anchor.y, width: 0, height: 0 }
}

/** Where native page views can be: anything drawn there must hide them until the overlay layer lands. */
function pageArea(): Rect | null {
  const el = document.querySelector('.workspace .content')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, width: r.width, height: r.height }
}

/** Mount once (UiHost does): it draws the open popover menu. */
export function PopoverHost(): ReactElement | null {
  useSyncExternalStore(subscribe, () => version)
  const request = current
  if (!request) return null
  return createPortal(<PopoverFrame key={version} request={request} />, document.body)
}

function PopoverFrame({ request }: { request: Request }): ReactElement {
  const { items, options, anchor } = request
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  // Measure, then place: it shows only once placed, so it never jumps.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const size = { width: el.offsetWidth, height: el.scrollHeight }
    const at = placePopover(anchorRect(anchor), size, { width: window.innerWidth, height: window.innerHeight }, {
      gap: options.gap ?? 4,
      align: options.align ?? 'start',
      side: options.side ?? 'below',
    })
    setPlace(at)
  }, [anchor, options.gap, options.align, options.side])

  // Pages are native views above the chrome: hide them only if the menu reaches over one.
  useEffect(() => {
    const el = box.current
    const page = pageArea()
    if (!place || !el || !page) return
    const rect = { left: place.left, top: place.top, width: el.offsetWidth, height: Math.min(el.scrollHeight, place.maxHeight) }
    return intersects(rect, page) ? holdOverlay() : undefined
  }, [place])

  // A click outside, the window losing focus, a resize or a scroll elsewhere dismiss it.
  useEffect(() => {
    const dismiss = (): void => request.resolve(null)
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (box.current?.contains(target)) return
      if (anchor instanceof Element && anchor.contains(target)) {
        // A press on the anchor closes it; the click that follows must not reopen it.
        const swallow = (ev: Event): void => ev.stopPropagation()
        anchor.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => anchor.removeEventListener('click', swallow, { capture: true }), 600)
      }
      dismiss()
    }
    const onScroll = (e: Event): void => {
      if (!box.current?.contains(e.target as Node)) dismiss()
    }
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [request, anchor])

  const close = (id: string | null, refocus: boolean): void => {
    request.resolve(id)
    if (refocus && anchor instanceof HTMLElement) anchor.focus({ preventScroll: true })
  }

  const lift = useMemo(() => liftedZIndex(anchor), [anchor])
  const style = {
    width: options.width,
    zIndex: lift ?? undefined,
    left: place?.left ?? 0,
    top: place?.top ?? 0,
    maxHeight: place?.maxHeight,
    visibility: place ? undefined : 'hidden',
    '--pop-row': `${options.rowHeight ?? 36}px`,
  } as CSSProperties
  return (
    <div ref={box} className={cx('ui-pop', options.muted && 'ui-pop--muted', options.className)} style={style} data-placed={place ? '' : undefined}>
      {options.header}
      <MenuList
        items={items}
        label={options.label}
        search={options.search}
        onChoose={(id) => close(id, true)}
        onDismiss={(refocus) => close(null, refocus)}
        onToggle={options.onToggle}
      />
    </div>
  )
}

/** Native-menu items as popover rows: radios and checks get the check slot, submenus a chevron, shortcuts their keys. */
export function popoverItemsFromSpec(items: readonly MenuItemSpec[]): PopoverItem[] {
  return items.map((item): PopoverItem => {
    if (item.type === 'separator') return { id: item.id, label: '', kind: 'separator' }
    const checkable = item.type === 'radio' || item.type === 'checkbox'
    return {
      id: item.id,
      label: item.label,
      disabled: item.enabled === false,
      danger: item.danger,
      checked: item.checked,
      trailing: item.submenu ? 'chevron' : checkable ? 'check' : item.accelerator ? <kbd className="ui-pop__keys">{formatShortcut(item.accelerator, isMac)}</kbd> : undefined,
    }
  })
}

/**
 * The same items a native menu would take, shown in-window. A submenu row
 * opens its items in place of the menu (a drill-in), under the same anchor,
 * and the promise resolves to the leaf that was chosen.
 */
export async function showSpecPopover(items: readonly MenuItemSpec[], anchor: PopoverAnchor, options: PopoverMenuOptions): Promise<string | null> {
  const id = await showPopoverMenu(popoverItemsFromSpec(items), anchor, options)
  const picked = id ? items.find((item) => item.id === id) : undefined
  if (picked?.submenu) return showSpecPopover(picked.submenu, anchor, { ...options, header: undefined, label: picked.label })
  return id
}
