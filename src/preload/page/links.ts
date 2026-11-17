/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcRenderer } from 'electron'
import { PAGE, PAGE_LINK_HREF_MAX, type PageLinkMessage } from '@shared/ipc'

// Link gestures in the page, reported on
// PAGE.links: ⌥ held over a link and a 500 ms press ask for the preview
// card, leaving the link hides it, and ⇧-click opens Peek instead of a new
// window. ⌘-click, middle-click and ⇧⌘-click keep Chromium's own handling
// (background and foreground tabs). Nothing here is visible to the page.

const LONG_PRESS_MS = 500
const MOVE_SLOP_PX = 8

function linkOf(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target.closest('a[href]') : null
  return el instanceof HTMLAnchorElement ? el : null
}

/** Only links Peek and the preview can show. */
function usable(link: HTMLAnchorElement): boolean {
  return /^(https?|file):/i.test(link.href) && link.href.length <= PAGE_LINK_HREF_MAX
}

function send(kind: PageLinkMessage['kind'], link: HTMLAnchorElement | null): void {
  const r = link?.getBoundingClientRect()
  const message: PageLinkMessage = {
    kind,
    href: link ? link.href.slice(0, PAGE_LINK_HREF_MAX) : '',
    rect: r ? { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : { x: 0, y: 0, width: 0, height: 0 },
  }
  ipcRenderer.send(PAGE.links, message)
}

export function installLinks(): void {
  let hovered: HTMLAnchorElement | null = null
  let previewing: HTMLAnchorElement | null = null
  let press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null
  // A long press shows the card; the click that ends it must not follow the link.
  let swallowClick = false

  const show = (link: HTMLAnchorElement, kind: 'alt-hover' | 'long-press'): void => {
    if (!usable(link) || previewing === link) return
    previewing = link
    send(kind, link)
  }
  const hide = (): void => {
    if (!previewing) return
    previewing = null
    send('leave', null)
  }
  const cancelPress = (): void => {
    if (press) clearTimeout(press.timer)
    press = null
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      hovered = linkOf(e.target)
      if (hovered && e.altKey) show(hovered, 'alt-hover')
      else if (previewing && hovered !== previewing) hide()
    },
    true,
  )
  document.addEventListener(
    'mouseout',
    (e) => {
      if (linkOf(e.relatedTarget) === null) {
        hovered = null
        hide()
      }
    },
    true,
  )
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Alt' && hovered) show(hovered, 'alt-hover')
      else if (e.key === 'Escape') hide()
    },
    true,
  )
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Alt' && previewing && !press) hide()
    },
    true,
  )
  window.addEventListener('blur', () => {
    cancelPress()
    hide()
  })
  window.addEventListener('scroll', hide, { capture: true, passive: true })

  document.addEventListener(
    'pointerdown',
    (e) => {
      swallowClick = false
      cancelPress()
      if (e.button !== 0 || e.pointerType === 'pen') return
      const link = linkOf(e.target)
      if (!link || !usable(link)) return
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null
          swallowClick = true
          show(link, 'long-press')
        }, LONG_PRESS_MS),
      }
    },
    true,
  )
  document.addEventListener(
    'pointermove',
    (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_SLOP_PX) cancelPress()
    },
    true,
  )
  document.addEventListener('pointerup', cancelPress, true)
  document.addEventListener('pointercancel', cancelPress, true)

  document.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        swallowClick = false
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      // ⇧-click alone opens Peek; with ⌘ or Ctrl it stays a foreground tab.
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.button !== 0) return
      const link = linkOf(e.target)
      if (!link || !usable(link)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      hide()
      send('shift-click', link)
    },
    true,
  )
}
