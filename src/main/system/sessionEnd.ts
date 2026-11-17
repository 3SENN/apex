/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, BrowserWindow } from 'electron'
import { log } from '../log'

// Windows ending the session (shut down, restart, sign out) never emits
// 'before-quit' or 'will-quit': Windows ends Atelier once its windows have
// answered WM_ENDSESSION. Each window's 'session-end' comes from that message,
// so what quitting saves has to happen there, and synchronously: the session
// and history files, the clean-exit marker (or the next start says Atelier quit
// unexpectedly), and a running recording (it starts saving, and whatever the
// helper can't finish is put back together on the next start). Only win32
// sends it; elsewhere the quit events run as usual.

type Handler = () => void

export interface SessionEndHub {
  /** `last`: after every other handler (the diagnostics' clean-exit marker and log flush). */
  on(fn: Handler, opts?: { last?: boolean }): () => void
  /** Runs every handler once, in the order they were added (`last` ones after); later calls do nothing. */
  end(): void
}

export function sessionEndHub(warn: (message: string, data: Record<string, string>) => void = () => undefined): SessionEndHub {
  const handlers: Array<{ fn: Handler; last: boolean }> = []
  let ended = false
  return {
    on(fn, opts) {
      const entry = { fn, last: opts?.last === true }
      handlers.push(entry)
      return () => {
        const at = handlers.indexOf(entry)
        if (at !== -1) handlers.splice(at, 1)
      }
    },
    end() {
      if (ended) return
      ended = true
      const order = [...handlers.filter((h) => !h.last), ...handlers.filter((h) => h.last)].map((h) => h.fn)
      for (const fn of order) {
        try {
          fn()
        } catch (err) {
          warn('A session-end step failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
    },
  }
}

const hub = sessionEndHub((message, data) => log.warn('system', message, data))
let watching = false

function watch(): void {
  if (watching || process.platform !== 'win32') return
  watching = true
  const end = (): void => {
    log.info('system', 'Windows is ending the session')
    hub.end()
  }
  const add = (win: BrowserWindow): void => {
    win.once('session-end', end)
  }
  for (const win of BrowserWindow.getAllWindows()) add(win)
  app.on('browser-window-created', (_event, win) => add(win))
}

/** Runs `fn` when Windows ends the session (see above); returns the way to stop. */
export function onSessionEnd(fn: Handler, opts?: { last?: boolean }): () => void {
  watch()
  return hub.on(fn, opts)
}
