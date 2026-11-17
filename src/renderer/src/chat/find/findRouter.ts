/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type RefObject } from 'react'
import { apex } from '../../api'

// ⌘F in a chat (CH-37). Main's intercept of the 'find' command sends
// 'find-in-chat' while a chat page is the active tab; a key handler covers ⌘F
// pressed with focus inside the panel or a chat page. Either way the chat
// surface with focus (else the visible chat page) opens its find bar. On a
// website nothing here runs, so ⌘F still finds in the page.

export interface FindTarget {
  kind: 'page' | 'panel'
  root(): HTMLElement | null
  open(): void
  close(): void
}

const targets = new Set<FindTarget>()

const visible = (el: HTMLElement | null): el is HTMLElement => !!el && el.isConnected && el.getClientRects().length > 0

/** The surface ⌘F belongs to: the one holding focus, else (for main's command) a visible chat page. */
function pick(fromCommand: boolean): FindTarget | null {
  const active = document.activeElement
  for (const target of targets) {
    const root = target.root()
    if (visible(root) && active && root.contains(active)) return target
  }
  if (!fromCommand && active && active !== document.body) return null
  for (const target of targets) if (target.kind === 'page' && visible(target.root())) return target
  return null
}

function openFor(target: FindTarget): void {
  // One find bar at a time: its highlights are the window's.
  for (const other of targets) if (other !== target) other.close()
  target.open()
}

let started = false

export function startChatFind(): void {
  if (started) return
  started = true
  apex.onCommand((command) => {
    if ((command as string) !== 'find-in-chat') return
    const target = pick(true)
    if (target) openFor(target)
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key.toLowerCase() !== 'f' || e.shiftKey || e.altKey || !(e.metaKey || e.ctrlKey) || (e.metaKey && e.ctrlKey)) return
      const target = pick(false)
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      openFor(target)
    },
    true,
  )
}

/** A chat surface's find bar state, registered with the router while mounted. */
export function useChatFindTarget(kind: FindTarget['kind'], root: RefObject<HTMLElement | null>): { open: boolean; setOpen(open: boolean): void; nonce: number } {
  const [open, setOpen] = useState(false)
  // Pressing ⌘F again while open refocuses the field and selects its text.
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const target: FindTarget = {
      kind,
      root: () => root.current,
      open: () => {
        setOpen(true)
        setNonce((n) => n + 1)
      },
      close: () => setOpen(false),
    }
    targets.add(target)
    return () => void targets.delete(target)
  }, [kind, root])
  return { open, setOpen, nonce }
}
