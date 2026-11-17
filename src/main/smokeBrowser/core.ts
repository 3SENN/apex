/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { core } from '../app'
import { commands } from '../commands'
import type { WindowContext } from '../features/types'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// Core smoke checks and light and dark shots: the
// overlay host draws a tooltip, the fullscreen notice and the shortcuts
// sheet above the page; a second window and a private window open with
// their own chrome; the private one is never written to session.json; ⌘W
// closes one tab per press and ⇧⌘T brings it back.

function handle(): NonNullable<ReturnType<typeof core>> {
  const h = core()
  assert(h, 'the core is running')
  return h
}

function firstWindow(ctx: SmokeContext): WindowContext {
  const win = handle().windows.all().find((w) => w.chrome === ctx.chrome.ui)
  assert(win, 'the first window')
  return win
}

/** Waits until `selector` is drawn in one of the window's overlay tiers. */
async function drawn(win: WindowContext, tier: 'interactive' | 'passive', selector: string): Promise<void> {
  await waitFor(
    async () => {
      const wc = win.overlay.tierWebContents(tier)
      if (!wc || wc.isDestroyed()) return false
      return new Chrome(wc).js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)
    },
    8000,
    `${selector} in the ${tier} overlay`,
  )
}

function anchorRect(win: WindowContext): { x: number; y: number; width: number; height: number } {
  const { width, height } = win.window.getContentBounds()
  return { x: 0, y: 0, width, height }
}

const tooltipShot: ShotSpec = {
  name: 'core-tooltip',
  async run(ctx) {
    const win = firstWindow(ctx)
    void win.overlay.open('tooltip', { kind: 'window', rect: { x: 120, y: 12, width: 28, height: 28 } }, { label: 'New tab', shortcutId: 'new-tab' })
    await drawn(win, 'passive', '.ov-tooltip')
    await sleep(250)
    await ctx.shot('core-tooltip')
    win.overlay.closeAll((s) => s === 'tooltip')
  },
}

const noticeShot: ShotSpec = {
  name: 'core-fullscreen-notice',
  async run(ctx) {
    const win = firstWindow(ctx)
    void win.overlay.open('fullscreen-notice', { kind: 'window', rect: anchorRect(win) }, { host: 'example.test' })
    await drawn(win, 'passive', '.ov-fs-notice')
    await sleep(250)
    await ctx.shot('core-fullscreen-notice')
    win.overlay.closeAll((s) => s === 'fullscreen-notice')
  },
}

const sheetShot: ShotSpec = {
  name: 'core-shortcuts-sheet',
  async run(ctx) {
    const win = firstWindow(ctx)
    await commands.run('shortcuts-sheet', win)
    await drawn(win, 'interactive', '.ov-sheet')
    await sleep(300)
    await ctx.shot('core-shortcuts-sheet')
    win.overlay.closeAll((s) => s === 'shortcuts-sheet')
    await sleep(300)
  },
}

const windowsCheck: SmokeCheck = {
  name: 'core: a second window and a private window open; the private one is never saved',
  async run(ctx) {
    const { windows } = handle()
    const before = windows.all().length
    const normalId = windows.open('normal')
    const privateId = windows.open('private')
    await waitFor(() => windows.all().length === before + 2, 8000, 'two more windows')
    const kinds = windows.list().map((w) => [w.id, w.kind] as const)
    assert(kinds.some(([id, kind]) => id === normalId && kind === 'normal'), 'the second window is normal')
    assert(kinds.some(([id, kind]) => id === privateId && kind === 'private'), 'the private window is private')
    const priv = windows.get(privateId)
    assert(priv, 'the private window context')
    assert(priv.session !== firstWindow(ctx).session, 'the private window has its own session')
    await waitFor(() => new Chrome(priv.chrome).js<boolean>(`return Boolean(document.querySelector('.private-label'))`).catch(() => false), 10000, 'the private label')
    const saved = windows.serialize()
    assert(saved.windows.length <= windows.all().filter((w) => w.kind === 'normal').length, 'only normal windows are saved')
    for (const id of [normalId, privateId]) windows.closeNow(id)
    await waitFor(() => windows.all().length === before, 8000, 'the extra windows to close')
  },
}

const closeOrderCheck: SmokeCheck = {
  name: 'core: ⌘W closes one tab per press and ⇧⌘T reopens it',
  async run(ctx) {
    const win = firstWindow(ctx)
    win.window.focus()
    ctx.tabs.create(`${ctx.server.http}/`)
    ctx.tabs.create(`${ctx.server.http}/`)
    await sleep(350)
    const count = ctx.tabs.all().length
    // Two presses inside the coalescing window close one tab.
    await commands.run('close-tab', win)
    await commands.run('close-tab', win)
    assert(ctx.tabs.all().length === count - 1, `one tab closed (${ctx.tabs.all().length} of ${count})`)
    await sleep(350)
    assert(handle().windows.reopen(), 'a closed tab to reopen')
    await waitFor(() => ctx.tabs.all().length === count, 5000, 'the reopened tab')
  },
}

export const checks: SmokeCheck[] = [windowsCheck, closeOrderCheck]
export const shots: ShotSpec[] = [tooltipShot, noticeShot, sheetShot]
