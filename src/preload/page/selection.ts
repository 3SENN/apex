/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The selection reports for the selection chip (OV-20) on
// PAGE.selection. Runs in the isolated world of the tab's main frame: it
// reads the selection's text, where it is and the links inside it, and says
// "cleared" when the selection collapses, the page scrolls or the selection
// is in a field (never a password, never anything you are typing in).
import { ipcRenderer } from 'electron'
import { PAGE, type PageSelectionMessage } from '@shared/ipc'
import { sameSelection, selectionBlocked, selectionMessage, type FocusFacts } from './selectionRules'

let last: PageSelectionMessage | null = null
let pending: ReturnType<typeof setTimeout> | null = null
/** True between a pointer press and its release, so a drag in progress isn't reported. */
let pressing = false

function focusFacts(el: Element | null): FocusFacts | null {
  if (!el) return null
  const html = el as HTMLElement
  return {
    tag: el.tagName,
    type: el.getAttribute('type'),
    autocomplete: el.getAttribute('autocomplete'),
    editable: html.isContentEditable === true,
  }
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/** Whether either end of the selection, or the focused element, is a field. */
function inField(selection: Selection): boolean {
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const el = elementOf(node)
    const field = el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') ?? null
    if (field && selectionBlocked(focusFacts(field))) return true
  }
  const active = document.activeElement
  return active !== null && active !== document.body && selectionBlocked(focusFacts(active))
}

function linksIn(range: Range): string[] {
  const out: string[] = []
  const root = range.commonAncestorContainer
  const scope = elementOf(root)
  if (!scope) return out
  // The link the selection sits inside counts too.
  const around = scope.closest('a[href]') as HTMLAnchorElement | null
  if (around) out.push(around.href)
  for (const a of Array.from(scope.querySelectorAll('a[href]')) as HTMLAnchorElement[]) {
    if (range.intersectsNode(a)) out.push(a.href)
    if (out.length > 40) break
  }
  return out
}

function report(): void {
  pending = null
  const selection = window.getSelection()
  let message: PageSelectionMessage
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    message = { cleared: true }
  } else {
    const range = selection.getRangeAt(0)
    const box = range.getBoundingClientRect()
    message = selectionMessage({
      text: selection.toString(),
      collapsed: selection.isCollapsed,
      rect: { x: box.left, y: box.top, width: box.width, height: box.height },
      links: linksIn(range),
      url: location.href,
      blocked: inField(selection),
    })
  }
  if (sameSelection(last, message)) return
  // Nothing to clear when nothing was offered.
  if ('cleared' in message && (!last || 'cleared' in last)) {
    last = message
    return
  }
  last = message
  ipcRenderer.send(PAGE.selection, message)
}

function schedule(delay: number): void {
  if (pending) clearTimeout(pending)
  pending = setTimeout(report, delay)
}

function clear(): void {
  if (pending) clearTimeout(pending)
  pending = null
  if (!last || 'cleared' in last) return
  last = { cleared: true }
  ipcRenderer.send(PAGE.selection, last)
}

export function installSelection(): void {
  // Only the top frame reports; the chip anchors to the tab.
  if (window !== window.top) return
  document.addEventListener('pointerdown', () => {
    pressing = true
    clear()
  }, true)
  document.addEventListener('pointerup', () => {
    pressing = false
    schedule(30)
  }, true)
  // Keyboard selections (⇧-arrows, ⌘A) settle a moment after the last key.
  document.addEventListener('selectionchange', () => {
    if (pressing) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) clear()
    else schedule(250)
  })
  window.addEventListener('scroll', clear, { capture: true, passive: true })
  // Not on blur: a click on the chip itself moves focus to the overlay.
  window.addEventListener('pagehide', clear)
}
