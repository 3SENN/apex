/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shows a dialog from plain code (a native menu's click, the + menu) and
// resolves with what it returns. The dialog gets its own React root, which
// is unmounted once it has answered.
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

export function mountDialog<T>(render: (done: (value: T) => void) => ReactElement): Promise<T> {
  return new Promise<T>((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let answered = false
    const done = (value: T): void => {
      if (answered) return
      answered = true
      resolve(value)
      // Let the dialog's own close run before its root goes.
      setTimeout(() => {
        root.unmount()
        host.remove()
      }, 0)
    }
    root.render(render(done))
  })
}
