/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MenuItemSpec } from '@shared/menu'
import { call } from '../api'
import { openInChrome } from '../overlay/kit/chromeHost'
import { fromSpec, popoverMenuSurface } from '../overlay/kit/PopoverMenu'
import type { KitItem } from '../overlay/kit/types'
import { t } from '@shared/i18n/core'
import { menuAnchorPoint } from './logic/format'

export type { MenuItemSpec } from '@shared/menu'

/** An element to open under, or a point in the chrome's CSS pixels. */
export type MenuAnchor = Element | { x: number; y: number }

/**
 * Opens a menu and resolves to the clicked item's id, or null when it was
 * dismissed. Under an element it is the in-window menu (DS-94: one popover
 * serves every menu that opens from a control); at a point it is a native
 * context menu. While it is open the anchor
 * carries data-menu-open, and aria-expanded if it declares aria-haspopup.
 */
export async function showMenu(items: MenuItemSpec[], anchor: MenuAnchor): Promise<string | null> {
  if (menuKind(anchor) === 'popover') return showPopoverMenu(items, anchor as HTMLElement, { label: menuLabel(anchor as HTMLElement) })
  return nativeMenu(items, anchor)
}

/** In-window under a control; native at a point (and for an SVG or other non-HTML anchor). */
export function menuKind(anchor: MenuAnchor): 'popover' | 'native' {
  return typeof HTMLElement !== 'undefined' && anchor instanceof HTMLElement ? 'popover' : 'native'
}

/** The menu's accessible name: what the control that opened it is called. */
export function menuLabel(anchor: Pick<Element, 'getAttribute' | 'textContent'>): string {
  const named = anchor.getAttribute('aria-label') ?? anchor.getAttribute('title') ?? anchor.textContent
  return named?.replace(/\s+/g, ' ').trim() || t('capture.card.more')
}

/** Menu.popup in main. Native menus draw above page views, so no overlay hold is needed. */
async function nativeMenu(items: MenuItemSpec[], anchor: MenuAnchor): Promise<string | null> {
  const isElement = typeof Element !== 'undefined' && anchor instanceof Element
  const { x, y } = isElement ? menuAnchorPoint(anchor.getBoundingClientRect()) : { x: Math.round((anchor as { x: number }).x), y: Math.round((anchor as { y: number }).y) }
  const expands = isElement && anchor.hasAttribute('aria-haspopup')
  if (isElement) anchor.setAttribute('data-menu-open', '')
  if (expands) anchor.setAttribute('aria-expanded', 'true')
  try {
    return await call('menu', 'popup', items, x, y)
  } finally {
    if (isElement) anchor.removeAttribute('data-menu-open')
    if (expands) anchor.setAttribute('aria-expanded', 'false')
  }
}

/** A context menu at the pointer; call from onContextMenu. */
export function showContextMenu(event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void }, items: MenuItemSpec[]): Promise<string | null> {
  event.preventDefault()
  // The context-menu key and Shift+F10 report (0, 0): open under the element instead.
  const fromKeyboard = event.clientX === 0 && event.clientY === 0 && event.currentTarget instanceof Element
  return nativeMenu(items, fromKeyboard ? (event.currentTarget as Element) : { x: event.clientX, y: event.clientY })
}

let separators = 0
/** A separator entry (ids must be unique within a menu). */
export function menuSeparator(): MenuItemSpec {
  return { id: `separator-${++separators}`, label: '', type: 'separator' }
}

export interface PopoverMenuOptions {
  /** The menu's accessible name. */
  label: string
  /** A search row with this placeholder (long submenus get one anyway). */
  search?: string
  width?: number
  /** 36 px rows by default. */
  rowHeight?: number
  side?: 'below' | 'above'
  align?: 'start' | 'end'
  gap?: number
}

/**
 * The in-window menu (DS-94): a kit card under or above `anchor`
 * with headed groups, switch, check, lock and chevron slots, shortcuts,
 * cascading side cards and type-to-filter. Resolves to the chosen row's id,
 * or null when dismissed; Escape gives focus back to the anchor, which stays
 * pressed while open. Takes native-menu specs or kit rows; showMenu uses it
 * for every menu under a control. Context menus stay native (showContextMenu).
 */
export async function showPopoverMenu(items: readonly MenuItemSpec[] | readonly KitItem[], anchor: HTMLElement, options: PopoverMenuOptions): Promise<string | null> {
  const mac = navigator.platform.toLowerCase().includes('mac')
  const rows = items.some((i) => 'kind' in i || 'icon' in i || 'shortcut' in i) ? (items as KitItem[]) : fromSpec(items as MenuItemSpec[], mac)
  const r = anchor.getBoundingClientRect()
  const side = options.side ?? (r.top > window.innerHeight * 0.6 ? 'above' : 'below')
  const result = await openInChrome(
    popoverMenuSurface,
    { items: rows, label: options.label, search: options.search, width: options.width, rowHeight: options.rowHeight, side, align: options.align ?? 'start', gap: options.gap },
    { kind: 'window', rect: { x: r.left, y: r.top, width: r.width, height: r.height } },
    { anchorEl: anchor },
  )
  if (!('value' in result)) return null
  if (typeof result.value === 'string') return result.value
  anchor.focus({ preventScroll: true })
  return null
}
