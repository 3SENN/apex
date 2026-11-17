/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcRenderer } from 'electron'
import { PAGE, type PageScrollMessage } from '@shared/ipc'

// Page scroll for page-anchored surfaces: sent on
// PAGE.scroll, throttled to about 60 ms, so a surface anchored to the page
// follows or closes.
const THROTTLE_MS = 60

export function installScroll(): void {
  let last = 0
  let pending: ReturnType<typeof setTimeout> | null = null
  const send = (): void => {
    pending = null
    last = Date.now()
    const message: PageScrollMessage = { scrollX: window.scrollX, scrollY: window.scrollY }
    ipcRenderer.send(PAGE.scroll, message)
  }
  window.addEventListener(
    'scroll',
    () => {
      if (pending) return
      const wait = Math.max(0, THROTTLE_MS - (Date.now() - last))
      pending = setTimeout(send, wait)
    },
    { passive: true, capture: true },
  )
  // A starting position, so the first scroll already has something to compare with.
  window.addEventListener('DOMContentLoaded', send, { once: true })
}
