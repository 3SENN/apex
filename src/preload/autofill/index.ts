/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcRenderer } from 'electron'
import { PAGE_AUTOFILL, type FrameReport, type MainCommand } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import { USERNAME_MAX } from '@shared/passwords'
import { SubmitWatcher, isSubmitControl } from './capture'
import { deepActiveElement, groupRoot, guardOfElement, guardedRects, idOf, isFieldElement, kindOf, readGroup, rectOf, roleForField, rootById, type FieldElement } from './dom'
import { fillGroup } from './fill'
import { listenForProbes, postProbe } from './frames'

// Autofill in the page (OV-25 to OV-29), installed in every
// frame, nested and cross-origin ones too. It reports trusted, user-started
// focus on login, card and address fields; forwards the arrow keys, Return
// and Esc while a popup is open; reports scrolls, moves and submissions;
// fills what main sends; answers frame-offset probes; and reports guarded
// fields for the capture mask. Main decides everything else.

/** A focus counts as the person's own within this long of their last press or key. */
const GESTURE_MS = 1500
const MOVE_POLL_MS = 200
const TOUCH_DEBOUNCE_MS = 150

function send(report: FrameReport): void {
  try {
    ipcRenderer.send(PAGE_AUTOFILL.report, report)
  } catch {
    // The frame is going away.
  }
}

/** The element an event really started on, inside open shadow roots. */
function origin(e: Event): EventTarget | null {
  return e.composedPath()[0] ?? e.target
}

function sameRect(a: Bounds, b: Bounds): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

export function installAutofill(): void {
  let lastGesture = 0
  const typed = new WeakSet<Element>()
  let focused: { el: FieldElement; id: string; rect: Bounds } | null = null
  let popup = { open: false, active: false }
  let movePoll: ReturnType<typeof setInterval> | null = null
  const touchTimers = new Map<Element, ReturnType<typeof setTimeout>>()

  const watcher = new SubmitWatcher((s, trigger) => send({ type: 'submit', form: s.form, values: s.values, trigger }))
  const userStarted = (): boolean => Date.now() - lastGesture < GESTURE_MS || navigator.userActivation?.isActive === true

  /** Reports a focus on a field Atelier can help with; false when it isn't one. */
  const reportFocus = (el: FieldElement): boolean => {
    const kind = kindOf(el)
    if (!kind) return false
    const group = readGroup(groupRoot(el))
    const role = roleForField(kind, group)
    if (!role) return false
    const has = (kinds: string[]): boolean => group.fields.some((f) => f.kind !== null && kinds.includes(f.kind) && f.el.value !== '')
    const named = group.fields.find((f) => (f.kind === 'username' || f.kind === 'email') && f.el.value.trim() !== '')
    const id = idOf(el, 'f')
    const rect = rectOf(el)
    focused = { el, id, rect }
    const login = role === 'login' || role === 'signup'
    send({
      type: 'focus',
      fieldId: id,
      kind,
      rect,
      formId: group.id,
      filled: { username: has(['username', 'email']), password: has(['current-password']) },
      typed: typed.has(el) && el.value !== '',
      trusted: true,
      formRole: role,
      ...(login && named ? { username: named.el.value.trim().slice(0, USERNAME_MAX) } : {}),
    })
    return true
  }

  const stopPolling = (): void => {
    if (movePoll) clearInterval(movePoll)
    movePoll = null
  }
  // A resize or a reflow moves the field without a scroll: the popup follows, and its stillness wait starts over.
  const checkMoved = (): void => {
    if (!focused || !popup.open) return
    if (!focused.el.isConnected) {
      send({ type: 'blur', fieldId: focused.id })
      return
    }
    const rect = rectOf(focused.el)
    if (sameRect(rect, focused.rect)) return
    focused.rect = rect
    send({ type: 'moved', fieldId: focused.id, rect })
  }

  window.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isTrusted) return
      lastGesture = Date.now()
      // A click on the field that already has focus reopens a dismissed popup.
      const target = origin(e)
      if (isFieldElement(target) && target === deepActiveElement() && !popup.open) setTimeout(() => reportFocus(target), 0)
    },
    true,
  )

  window.addEventListener(
    'focusin',
    (e) => {
      const target = origin(e)
      if (!e.isTrusted || !isFieldElement(target) || !userStarted()) return
      if (!reportFocus(target) && focused) {
        send({ type: 'blur', fieldId: focused.id })
        focused = null
      }
    },
    true,
  )

  window.addEventListener(
    'focusout',
    (e) => {
      const current = focused
      if (!current || origin(e) !== current.el) return
      setTimeout(() => {
        // The window losing focus (a click on the popup itself) leaves the field focused; only moving to another element is a blur.
        if (deepActiveElement() === current.el && current.el.isConnected) return
        if (focused === current) focused = null
        send({ type: 'blur', fieldId: current.id })
      }, 0)
    },
    true,
  )

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.isComposing) return
      lastGesture = Date.now()
      const target = origin(e)
      if (!isFieldElement(target)) return
      const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey
      // While a popup is open, the arrows, Esc, and Return on a highlighted row drive it instead of the page.
      if (popup.open && focused?.el === target && plain) {
        const key = e.key
        if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Escape' || (key === 'Enter' && popup.active)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          send({ type: 'key', key })
          return
        }
      }
      if (!popup.open && e.key === 'ArrowDown' && plain && target instanceof HTMLInputElement) reportFocus(target)
      if (e.key === 'Enter' && !(target instanceof HTMLTextAreaElement) && kindOf(target)) {
        const root = groupRoot(target)
        watcher.submitted(root, 'enter')
      }
    },
    true,
  )

  window.addEventListener(
    'input',
    (e) => {
      const target = origin(e)
      if (!e.isTrusted || !isFieldElement(target) || !kindOf(target)) return
      typed.add(target)
      const root = groupRoot(target)
      const pending = touchTimers.get(root)
      if (pending) clearTimeout(pending)
      touchTimers.set(
        root,
        setTimeout(() => {
          touchTimers.delete(root)
          watcher.touched(root)
        }, TOUCH_DEBOUNCE_MS),
      )
    },
    true,
  )

  const flushTouches = (): void => {
    for (const [root, timer] of [...touchTimers]) {
      clearTimeout(timer)
      touchTimers.delete(root)
      watcher.touched(root)
    }
  }

  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      flushTouches()
      // Only forms the person worked on: a page can't make Atelier offer to save values it planted.
      if (!watcher.isDirty(form) && !userStarted()) return
      watcher.submitted(form, 'submit')
    },
    true,
  )

  window.addEventListener(
    'click',
    (e) => {
      const target = origin(e)
      if (!e.isTrusted || !(target instanceof Element)) return
      flushTouches()
      for (const root of watcher.dirtyRoots()) if (isSubmitControl(target, root)) watcher.submitted(root, 'click')
    },
    true,
  )

  window.addEventListener('pagehide', () => {
    flushTouches()
    watcher.pageHidden()
  })

  window.addEventListener(
    'scroll',
    () => {
      if (!popup.open) return
      popup = { open: false, active: false }
      stopPolling()
      send({ type: 'scroll' })
    },
    { capture: true, passive: true },
  )
  window.addEventListener('resize', checkMoved)

  listenForProbes((nonce, childRect) => send({ type: 'probe', nonce, childRect }))

  ipcRenderer.on(PAGE_AUTOFILL.command, (_event, command: MainCommand) => {
    switch (command?.type) {
      case 'fill': {
        const root = rootById(command.formId)
        if (!root?.isConnected) return
        fillGroup(readGroup(root), command.values)
        // A filled form is one the person is using: its submit is captured like a typed one.
        watcher.touched(root)
        return
      }
      case 'popup':
        popup = { open: command.open, active: command.open && command.active === true }
        stopPolling()
        if (popup.open) movePoll = setInterval(checkMoved, MOVE_POLL_MS)
        return
      case 'probe-parent':
        postProbe(command.nonce)
        return
      case 'report-guarded':
        send({ type: 'guarded', rects: guardedRects(), focused: guardOfElement(deepActiveElement()) })
        return
    }
  })
}
