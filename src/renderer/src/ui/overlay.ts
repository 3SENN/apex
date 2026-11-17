/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { apex } from '../api'
import { createRefCount } from './logic/queues'

// Web pages are native views drawn above the chrome, so anything the chrome
// still draws over the page area must hide them while it is open. Holds are
// counted, so one surface closing never reveals the page under another.
//
// The legacy shim: a hold is a `cover` surface in the overlay host,
// which hides the page views while it is open. Surfaces that moved into the
// overlay (suggestions, menus, dialogs, toasts) need no hold: they draw above
// the page. If the overlay can't take the cover (a crashed tier), the old
// hide-the-page channel stands in. Integration deletes this with UI.overlay.

let want = false
let coverId: string | null = null
let opening = false
let legacy = false

function sync(): void {
  if (legacy) {
    apex.layout.setOverlayOpen(want)
    return
  }
  if (want && coverId === null && !opening) {
    opening = true
    apex.overlay.open('cover', { kind: 'window', rect: { x: 0, y: 0, width: 0, height: 0 } }, {}).then(
      ({ instanceId }) => {
        opening = false
        coverId = instanceId
        sync()
      },
      () => {
        opening = false
        legacy = true
        sync()
      },
    )
  } else if (!want && coverId !== null) {
    apex.overlay.close(coverId)
    coverId = null
  }
}

let listening = false
function listen(): void {
  if (listening) return
  listening = true
  apex.overlay.onResult((r) => {
    if (r.instanceId !== coverId) return
    coverId = null
    // A cover that timed out or crashed falls back to hiding the pages directly.
    if ('dismissed' in r && (r.dismissed === 'timeout' || r.dismissed === 'crashed')) legacy = true
    sync()
  })
}

const overlay = createRefCount((open) => {
  listen()
  want = open
  sync()
})

/** Hides the page views until the returned release is called. */
export function holdOverlay(): () => void {
  return overlay.acquire()
}

/** Holds the overlay while `active` is true. */
export function useOverlay(active: boolean): void {
  useEffect(() => (active ? overlay.acquire() : undefined), [active])
}
