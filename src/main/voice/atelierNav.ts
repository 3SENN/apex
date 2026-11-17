/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, shell } from 'electron'
import { PRIVACY_PANES, type PermissionKind, type SpeechBroker } from '@shared/speech'
import type { AppContext, WindowContext } from '../features/types'
import { errorMessage, log } from '../log'
import { screenAccess } from '../speech/screenAccess'
import { micFix } from './router'

// Bringing Atelier forward from a voice float: open an atelier:// page or a chat in
// a new foreground tab (a new window when none is open), and the macOS
// Privacy panes the voice errors point at.

/** The window a voice action lands in: the focused browser window, else the most recent one. */
export function targetWindow(ctx: AppContext): WindowContext | null {
  const wins = ctx.windows.all().filter((w) => !w.window.isDestroyed() && (w.kind === 'normal' || w.kind === 'private'))
  const focused = ctx.windows.focused()
  if (focused && wins.includes(focused)) return focused
  return wins[wins.length - 1] ?? null
}

/** Shows and focuses a window, taking focus from another app when the action came from a float. */
export function bringForward(win: WindowContext): void {
  if (win.window.isMinimized()) win.window.restore()
  win.window.show()
  win.window.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}

/** Opens `url` in a new foreground tab, or a new window when no browser window is open. Returns the window, or null. */
export function openInAtelier(ctx: AppContext, url: string): WindowContext | null {
  const win = targetWindow(ctx)
  if (win) {
    win.tabs.openInternal(url, { newTab: true })
    bringForward(win)
    return win
  }
  try {
    const id = ctx.windows.open('normal', { url })
    const opened = ctx.windows.get(id) ?? null
    if (opened) bringForward(opened)
    return opened
  } catch (err) {
    log.warn('voice', 'could not open a window', { error: errorMessage(err) })
    return null
  }
}

export function openPrivacyPane(kind: PermissionKind): void {
  void shell.openExternal(PRIVACY_PANES[kind]).catch(() => undefined)
}

/**
 * The mic-blocked fix, from the permissions as they are now (not the error
 * alone): macOS asks when it never has, else the right pane opens.
 * Resolves 'retry' once both are allowed, so the caller can listen again.
 */
export async function fixMicBlocked(broker: SpeechBroker, remembered: 'microphone' | 'speech'): Promise<'asked' | 'opened' | 'retry'> {
  const p = await broker.permissions().catch(() => null)
  const fix = micFix(p, remembered)
  if (fix.action === 'retry') return 'retry'
  if (fix.action === 'ask') {
    const next = await broker.request(fix.kind).catch(() => null)
    return next?.[fix.kind] === 'granted' ? 'retry' : 'asked'
  }
  openPrivacyPane(fix.kind)
  return 'opened'
}

/** The screenshot fix: macOS asks the first time, then System Settings; once it's on there, a relaunch. */
export async function fixScreenBlocked(): Promise<'asked' | 'opened' | 'relaunched' | 'granted'> {
  const host = screenAccess()
  const access = await host.status()
  if (access === 'granted' || access === 'unsupported') return 'granted'
  if (access === 'relaunch') {
    host.relaunch()
    return 'relaunched'
  }
  if (access === 'not-determined') {
    await host.request()
    return 'asked'
  }
  openPrivacyPane('screen')
  return 'opened'
}
