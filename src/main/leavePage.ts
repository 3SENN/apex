/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Event, WebContents } from 'electron'
import { t } from '@shared/i18n/core'
import { dialogs, toasts } from './dialogs'
import type { WindowContext } from './features/types'
import { allowNext, consumeSkip, isReload, pickIntent, record, redoPlan, type LeaveIntent, type LeaveState } from './leaveIntent'
import { log } from './log'
import { leaveStateOf } from './pageDialogs'
import type { Tab } from './tabs'

// "Leave this page?" (will-prevent-unload). Electron cancels the
// unload unless the handler prevents it synchronously, so Atelier lets it
// cancel, asks with its styled dialog, and on Leave replays what you were
// doing with a one-shot skip. Atelier's own navigations are recorded by
// wrapping the tab's navigation methods; the page's own ones arrive from
// its preload (pageDialogs.ts).

type Fn = (...args: never[]) => unknown

/** Records an intent before the original method runs. */
function wrap<T extends object, K extends keyof T>(target: T, key: K, intent: (...args: Parameters<Extract<T[K], Fn>>) => LeaveIntent | null, state: LeaveState): () => void {
  const original = target[key] as unknown as Fn
  if (typeof original !== 'function') return () => undefined
  const wrapped = function (this: unknown, ...args: never[]) {
    const next = intent(...(args as unknown as Parameters<Extract<T[K], Fn>>))
    if (next) record(state, next)
    return original.apply(this, args)
  }
  ;(target as Record<K, unknown>)[key] = wrapped
  return () => {
    if ((target as Record<K, unknown>)[key] === wrapped) (target as Record<K, unknown>)[key] = original
  }
}

function trackIntents(wc: WebContents, state: LeaveState): () => void {
  const now = (): number => Date.now()
  const history = wc.navigationHistory
  const undo = [
    wrap(wc, 'loadURL', (url: string) => ({ kind: 'load', url, at: now() }), state),
    wrap(wc, 'reload', () => ({ kind: 'reload', ignoreCache: false, at: now() }), state),
    wrap(wc, 'reloadIgnoringCache', () => ({ kind: 'reload', ignoreCache: true, at: now() }), state),
    wrap(wc, 'close', (opts?: { waitForBeforeUnload?: boolean }) => (opts?.waitForBeforeUnload ? { kind: 'close', at: now() } : null), state),
    wrap(history, 'goBack', () => ({ kind: 'history', offset: -1, at: now() }), state),
    wrap(history, 'goForward', () => ({ kind: 'history', offset: 1, at: now() }), state),
    wrap(history, 'goToOffset', (offset: number) => ({ kind: 'history', offset, at: now() }), state),
    wrap(history, 'goToIndex', (index: number) => ({ kind: 'index', index, at: now() }), state),
  ]
  return () => undo.forEach((u) => u())
}

function replay(wc: WebContents, intent: Exclude<LeaveIntent, { kind: 'page'; form: true }>): void {
  switch (intent.kind) {
    case 'load':
    case 'page':
      void wc.loadURL(intent.url).catch(() => undefined)
      break
    case 'reload':
      if (intent.ignoreCache) wc.reloadIgnoringCache()
      else wc.reload()
      break
    case 'history':
      wc.navigationHistory.goToOffset(intent.offset)
      break
    case 'index':
      wc.navigationHistory.goToIndex(intent.index)
      break
    case 'close':
      wc.close({ waitForBeforeUnload: true })
      break
  }
}

/** Per tab: answers will-prevent-unload with the styled confirm. */
export function watchUnload(tab: Tab, win: WindowContext): () => void {
  const wc = tab.view.webContents
  const state = leaveStateOf(wc)
  if (!state) return () => undefined
  const untrack = trackIntents(wc, state)

  const onPrevent = (event: Event): void => {
    const now = Date.now()
    if (consumeSkip(state, now)) {
      event.preventDefault()
      return
    }
    const intent = pickIntent(state, now)
    const reload = isReload(intent)
    // Not preventing it cancels this unload; the answer decides whether to redo it.
    void dialogs
      .show(
        win,
        {
          title: t(reload ? 'menus.leave.reloadTitle' : 'menus.leave.title'),
          description: t('menus.leave.body'),
          icon: 'warning',
          buttons: [
            { id: 'stay', label: t('menus.leave.stay'), style: 'secondary', escape: true, align: 'end' },
            { id: 'leave', label: t(reload ? 'menus.leave.reload' : 'menus.leave.leave'), style: 'destructive', enter: true, align: 'end' },
          ],
          dedupeKey: `leave:${tab.id}`,
        },
        { tabId: tab.id },
      )
      .then((result) => {
        if (result.button !== 'leave' || wc.isDestroyed()) return
        allowNext(state, Date.now())
        const plan = redoPlan(intent)
        if (plan.kind === 'replay') replay(wc, plan.intent)
        else void toasts.show(win, { kind: 'info', text: t(plan.reason === 'form' ? 'menus.leave.sendAgain' : 'menus.leave.tryAgain'), tabId: tab.id })
      })
      .catch((err: unknown) => log.warn('dialogs', 'Leave this page? failed', { error: err instanceof Error ? err.message : String(err) }))
  }

  wc.on('will-prevent-unload', onPrevent)
  return () => {
    untrack()
    if (!wc.isDestroyed()) wc.off('will-prevent-unload', onPrevent)
  }
}
