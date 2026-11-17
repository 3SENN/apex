/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { core } from '../app'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// SH-04, the edge reveal: with the sidebar hidden, reaching the window's left
// edge floats the sidebar over the page, on screen at full width, and it goes
// again when the pointer leaves. Main's poller (keyState.ts › edgeActive) is
// unit-tested; here the same event it sends drives the real chrome and overlay.

async function setLayout(ctx: SmokeContext, layout: 'sidebar' | 'horizontal'): Promise<void> {
  if (ctx.settings.get().layout === layout) return
  ctx.settings.update({ layout })
  await ctx.chrome.until(`return document.querySelector('.app--${layout}') ? true : null`, 5000, `the ${layout} layout`)
  await sleep(300)
}

const reveal: SmokeCheck = {
  name: 'sidebar reveal: with the sidebar hidden, the left edge floats it over the page, on screen, with the tabs of now',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    const layout = ctx.settings.get().layout
    await setLayout(ctx, 'sidebar')
    win.chromeWindow.setSidebarOpen(false)
    // Tabs opened after the overlay loaded: its own start-up state never had them.
    ctx.server.page('/reveal-tab', '<!doctype html><title>Reveal tab</title><p>A tab for the revealed sidebar</p>')
    const before = win.tabs.create(`${ctx.server.http}/reveal-tab`, { activate: false }).id
    const opened = [before]
    try {
      await ctx.chrome.until(`return document.querySelector('.app--sidebar-shown') ? null : true`, 5000, 'the sidebar to hide')
      win.send({ type: 'edge-reveal', active: true })
      let box: { x: number; y: number; width: number; height: number } | null = null
      // The sidebar slides in (sidebar-reveal-in: 16 px from the left, 150 ms) and its box includes that
      // transform, so it is measured once its animations have finished: where it rests, not mid-slide.
      await waitFor(
        async () => {
          const wc = win.overlay.tierWebContents('interactive')
          if (!wc || wc.isDestroyed()) return false
          box = await new Chrome(wc)
            .js<typeof box>(`const el = document.querySelector('.sidebar-reveal'); if (!el) return null; if (el.getAnimations().some((a) => a.playState !== 'finished' && a.playState !== 'idle')) return null; const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null`)
            .catch(() => null)
          return box !== null
        },
        6000,
        'the floating sidebar to come to rest',
      )
      await sleep(200)
      const view = win.overlay.interactiveBounds()
      const r = box as unknown as { x: number; y: number; width: number; height: number }
      assert(view, 'the overlay view is not showing')
      assert(r.x >= -1 && r.y >= -1 && r.x + r.width <= view.width + 1 && r.y + r.height <= view.height + 1, `the floating sidebar is drawn outside its view: ${JSON.stringify(r)} in ${JSON.stringify(view)}`)
      assert(view.x + r.x <= 12, `the floating sidebar is not at the left edge (x ${Math.round(view.x + r.x)})`)
      assert(r.width >= 200, `the floating sidebar is ${Math.round(r.width)} px wide`)
      const overlay = win.overlay.tierWebContents('interactive')!
      const listed = (id: string): Promise<boolean> => new Chrome(overlay).js<boolean>(`return document.querySelector('.sidebar-reveal .tab-row[data-tab-ids~="${id}"]') !== null`)
      assert(await listed(before), 'the floating sidebar does not list a tab opened before it showed')
      const during = win.tabs.create(`${ctx.server.http}/reveal-tab`, { activate: false }).id
      opened.push(during)
      await waitFor(() => listed(during), 3000, 'the floating sidebar to list a tab opened while it shows')
      // The strip between it and the window's edge counts as on it (the pointer rests there); a move over the page puts it away.
      const shown = (): boolean => win.overlay.openSurfaces().some((s) => s.surface === 'sidebar-reveal')
      // Chromium takes a move's movement from its screen position, and a move without any doesn't count.
      const zoom = overlay.getZoomFactor()
      const origin = win.window.getContentBounds()
      const y = Math.round((r.y + r.height / 2) * zoom)
      const move = (x: number): void => overlay.sendInputEvent({ type: 'mouseMove', x, y, globalX: origin.x + view.x + x, globalY: origin.y + view.y + y })
      move(Math.round((r.x + 20) * zoom))
      move(1)
      await sleep(250)
      assert(shown(), 'the floating sidebar went with the pointer resting at the window edge')
      move(Math.round((r.x + r.width + 60) * zoom))
      await waitFor(async () => !shown(), 2000, 'the floating sidebar to go with the pointer over the page')
    } finally {
      for (const id of opened) win.tabs.close(id)
      win.overlay.closeAll((s) => s === 'sidebar-reveal')
      win.chromeWindow.setSidebarOpen(true)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

export const checks: SmokeCheck[] = [reveal]
export const shots: ShotSpec[] = []
