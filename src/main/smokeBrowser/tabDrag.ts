/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, type WebContents } from 'electron'
import { core } from '../app'
import { steerTabDrag } from '../features/tabs'
import { assert, sleep, waitFor } from '../smokeKit'
import { ZONE_DROP_WAIT_MS } from '../tearOff'
import type { ShotSpec, SmokeCheck } from './types'

// Dragging a tab in the sidebar (SH-30, DS-16): a real HTML drag in the
// chrome, made through Chromium's drag interception (DevTools protocol), so
// the rows' own dragstart, dragover and drop handlers run. With nothing
// pinned, the pin target floats over the top rows while a tab is dragged:
// nothing under the pointer moves when it appears, and dropping on it pins.

type Rect = { x: number; y: number; width: number; height: number }

async function rect(ui: WebContents, selector: string): Promise<Rect | null> {
  return (await ui.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`, true)) as Rect | null
}

const centre = (r: Rect): { x: number; y: number } => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })

const pinByDrag: SmokeCheck = {
  name: 'a dragged tab drops onto the pin target, which floats in without moving the rows under the pointer',
  async run(ctx) {
    const ui = ctx.chrome.ui
    const pinned = ctx.tabs.all().filter((t) => ctx.tabs.info(t).pinned)
    for (const t of pinned) ctx.tabs.setPinned(t.id, false)
    const tab = ctx.tabs.create('about:blank', { activate: false })
    const row = `.sidebar [data-drop-row][data-drop-id="${tab.id}"]`
    const dbg = ui.debugger
    let attached = false
    let dragging = false
    let last = { x: 0, y: 0 }
    try {
      await waitFor(async () => (await rect(ui, row)) !== null, 5000, 'the new tab’s row in the sidebar')
      // A new row folds in with a short animation; measure it once it has settled.
      let prev: Rect | null = null
      await waitFor(async () => {
        const now = await rect(ui, row)
        const settled = prev !== null && now !== null && Math.abs(now.y - prev.y) < 0.5 && Math.abs(now.height - prev.height) < 0.5
        prev = now
        if (!settled) await sleep(120)
        return settled
      }, 5000, 'the new row to settle')
      dbg.attach('1.3')
      attached = true
      await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })
      const before = (await rect(ui, row)) as Rect
      const from = centre(before)
      let data: unknown = null
      const onMessage = (_e: unknown, method: string, params: { data?: unknown }): void => {
        if (method === 'Input.dragIntercepted') data = params.data
      }
      dbg.on('message', onMessage)
      try {
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
        for (let i = 1; i <= 6; i++) await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 3, y: from.y + i * 2, button: 'left', buttons: 1 })
        await waitFor(() => data !== null, 3000, 'the tab drag to start')
        dragging = true
        last = from
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: from.x, y: from.y, data })
        await ctx.chrome.until('return document.querySelector(".pin-grid--empty .pin-grid__hint") ? true : null', 5000, 'the floating pin target')
        await sleep(150)
        const during = (await rect(ui, row)) as Rect
        assert(Math.abs(during.y - before.y) < 1, `the dragged row moved when the pin target appeared (${before.y} → ${during.y})`)
        const hint = (await rect(ui, '.pin-grid__hint')) as Rect
        const at = centre(hint)
        last = at
        // A real pointer sends a stream of dragovers; the first into an element is its dragenter.
        for (let i = 0; i < 4; i++) {
          await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: at.x + i, y: at.y, data })
          await sleep(50)
        }
        const seen = await ctx.chrome.js<string>(`const el = document.elementFromPoint(${at.x}, ${at.y}); const g = document.querySelector('.pin-grid'); return JSON.stringify({ hit: el ? el.className + ' ' + el.tagName : null, grid: g ? g.className : null, hint: ${JSON.stringify(hint)} })`)
        await ctx.chrome.until('return document.querySelector(".pin-grid--over") ? true : null', 3000, `the pin target to light up (${seen})`)
        // Moving within the target keeps it lit (no flicker from drag-leave between its parts).
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: at.x + 20, y: at.y, data })
        assert(await ctx.chrome.js<boolean>('return Boolean(document.querySelector(".pin-grid--over"))'), 'the pin target went out while the pointer stayed on it')
        await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
        dragging = false
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      } finally {
        dbg.off('message', onMessage)
      }
      await waitFor(() => ctx.tabs.find(tab.id) !== undefined && ctx.tabs.info(tab).pinned, 5000, 'the dropped tab to be pinned')
    } finally {
      if (attached) {
        try {
          // A check that stopped mid-drag ends it, so the chrome doesn't stay in its dragging state for the next check.
          if (dragging) {
            await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: last.x, y: last.y, data: { items: [], dragOperationsMask: 1 } })
            await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', clickCount: 1 })
          }
          await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
        } catch {
          // Already detached.
        }
        dbg.detach()
      }
      if (ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
      for (const t of pinned) if (ctx.tabs.find(t.id)) ctx.tabs.setPinned(t.id, true)
    }
  },
}

// Drop to split (SH-30): the drag starts in the chrome as above, main's pointer is steered over the page
// (a check can't move a real drag's pointer), and the zones in the overlay get the drag as the page would
// have. A drop there splits on its side; a release with none (Escape) and a lost dragend split nothing,
// and the zones never outlive a drag.
const splitByDrag: SmokeCheck = {
  name: 'a tab dropped on a split zone opens on that side; Escape over the zones or a lost dragend splits nothing, and the zones always go',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    ctx.server.page('/split-drag', '<!doctype html><title>Split drag</title><p>A page to split beside</p>')
    const url = `${ctx.server.http}/split-drag`
    const base = ctx.tabs.create(url)
    const dragged = ctx.tabs.create(url, { activate: false })
    const other = ctx.tabs.create(url, { activate: false })
    const ui = ctx.chrome.ui
    const dbg = ui.debugger
    const overlay = win.overlay.tierWebContents('interactive')
    assert(overlay, 'the overlay renderer')
    const odbg = overlay.debugger
    let data: unknown = null
    let dragging = false
    const onMessage = (_e: unknown, method: string, params: { data?: unknown }): void => {
      if (method === 'Input.dragIntercepted') data = params.data
    }
    const zonesShown = (): boolean => win.overlay.openSurfaces().some((s) => s.surface === 'split-zones')
    // Main's pointer over the page's right zone, in screen px.
    const steerRight = (): void => {
      const page = win.tabs.layoutBounds().primary
      const origin = win.window.getContentBounds()
      steerTabDrag({ x: Math.round(origin.x + page.x + page.width * 0.85), y: Math.round(origin.y + page.y + page.height / 2) })
    }
    const startDrag = async (id: string): Promise<void> => {
      const row = `.sidebar [data-drop-row][data-drop-id="${id}"]`
      // New rows fold in with a short animation: press once the row has settled, or the press lands on its neighbour.
      let prev: Rect | null = null
      await waitFor(async () => {
        const now = await rect(ui, row)
        const settled = prev !== null && now !== null && Math.abs(now.y - prev.y) < 0.5 && Math.abs(now.height - prev.height) < 0.5
        prev = now
        if (!settled) await sleep(120)
        return settled
      }, 5000, 'the tab’s row to settle in the sidebar')
      const from = centre(prev as unknown as Rect)
      data = null
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 6; i++) await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 3, y: from.y + i * 2, button: 'left', buttons: 1 })
      await waitFor(() => data !== null, 3000, 'the tab drag to start')
      dragging = true
      steerRight()
      await waitFor(zonesShown, 3000, 'the split zones over the page')
    }
    /** The zones in the overlay get the drag, as the page under them would have; returns where the right zone is. */
    const dragOverZones = async (): Promise<{ x: number; y: number }> => {
      let zones: Rect | null = null
      await waitFor(async () => (zones = await rect(overlay, '.split-zones')) !== null && zones.width > 0, 3000, 'the zones to draw')
      const z = zones as unknown as Rect
      const at = { x: Math.round(z.x + z.width * 0.85), y: Math.round(z.y + z.height / 2) }
      await odbg.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data })
      for (let i = 0; i < 3; i++) await odbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: at.x + i, y: at.y, data })
      return at
    }
    /** The chrome's own drag ends with no drop on it: its dragend reaches main as the release. */
    const endSourceDrag = async (): Promise<void> => {
      await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: { items: [], dragOperationsMask: 1 } })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', clickCount: 1 })
      dragging = false
    }
    const zonesGone = async (why: string): Promise<void> => {
      await waitFor(() => !zonesShown(), 3000, `the zones to go ${why}`)
      await waitFor(async () => (await rect(overlay, '.split-zones')) === null, 3000, `the zones to leave the overlay ${why}`)
    }
    try {
      dbg.attach('1.3')
      odbg.attach('1.3')
      await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })
      dbg.on('message', onMessage)

      // 1. A drop on the right zone: the dragged tab opens on the right, and the zones go.
      await startDrag(dragged.id)
      // The ghost can never be a full-screen window: one with a Space of its own slid the screen there, black, on every drag.
      const ghost = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#ghost'))
      assert(ghost && ghost.isVisible(), 'the drag ghost isn’t showing')
      assert(!ghost.isFullScreenable() && !ghost.isFullScreen(), 'the drag ghost could become a full-screen window')
      // The zones cover the page, once its layout has settled (they open again over it when it moves).
      let cover: unknown = null
      await waitFor(
        async () => {
          const page = win.tabs.layoutBounds().primary
          const view = win.overlay.interactiveBounds()
          const zones = await rect(overlay, '.split-zones')
          cover = { zones, view, page }
          return view !== null && zones !== null && Math.abs(view.x + zones.x - page.x) <= 2 && Math.abs(zones.width - page.width) <= 2 && Math.abs(view.y + zones.y - page.y) <= 2 && Math.abs(zones.height - page.height) <= 2
        },
        3000,
        'the zones to cover the page',
      ).catch(() => {
        throw new Error(`the zones don’t cover the page: ${JSON.stringify(cover)}`)
      })
      const at = await dragOverZones()
      await waitFor(async () => (await rect(overlay, '.split-zone--right.split-zone--active')) !== null, 2000, 'the right zone to light up under the drag')
      await odbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
      await endSourceDrag()
      await waitFor(() => ctx.tabs.split()?.secondaryId === dragged.id, 3000, `the dropped tab to open on the right (split ${JSON.stringify(ctx.tabs.split())})`)
      assert(ctx.tabs.split()?.primaryId === base.id, `the other side is not the page it was dropped beside (${JSON.stringify(ctx.tabs.split())})`)
      await zonesGone('after the drop')

      // 2. Escape over the zones: the source's drag ends, no drop comes, nothing splits.
      ctx.tabs.closeSplit()
      ctx.tabs.activate(base.id)
      await startDrag(other.id)
      await dragOverZones()
      await odbg.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data })
      await endSourceDrag()
      await sleep(ZONE_DROP_WAIT_MS + 300)
      assert(ctx.tabs.split() === null, `a release over the zones without a drop split the view (${JSON.stringify(ctx.tabs.split())})`)
      await zonesGone('after Escape')

      // 3. A lost dragend: the zones' first real pointer move ends the drag as a cancel.
      await startDrag(other.id)
      const z = await dragOverZones()
      await odbg.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data })
      const origin = win.window.getContentBounds()
      const bounds = win.overlay.interactiveBounds() ?? { x: 0, y: 0 }
      // A stream of moves a frame apart, as a real pointer sends (moves within a frame merge into one): the
      // first after a drag has nothing to measure movement from.
      for (const dx of [0, 12, 24, 36]) {
        overlay.sendInputEvent({ type: 'mouseMove', x: z.x + dx, y: z.y, globalX: origin.x + bounds.x + z.x + dx, globalY: origin.y + bounds.y + z.y })
        await sleep(40)
      }
      await zonesGone('once the pointer moves without a drag')
      assert(ctx.tabs.split() === null, `a lost dragend split the view (${JSON.stringify(ctx.tabs.split())})`)
      await endSourceDrag()
    } finally {
      steerTabDrag(null)
      dbg.off('message', onMessage)
      try {
        if (dragging) await endSourceDrag()
        await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
      } catch {
        // Already detached.
      }
      if (dbg.isAttached()) dbg.detach()
      if (odbg.isAttached()) odbg.detach()
      ctx.tabs.closeSplit()
      for (const t of [dragged, other, base]) if (ctx.tabs.find(t.id)) ctx.tabs.close(t.id)
    }
  },
}

// The same drop from the floating sidebar (SH-04): with the sidebar hidden, the drag starts in the overlay,
// where the zones are too, so the drop never leaves the overlay.
const splitFromReveal: SmokeCheck = {
  name: 'a tab dragged from the floating sidebar onto a split zone opens on that side, and the zones go',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    const overlay = win.overlay.tierWebContents('interactive')
    assert(overlay, 'the overlay renderer')
    ctx.server.page('/split-reveal', '<!doctype html><title>Split reveal</title><p>A page to split beside</p>')
    const url = `${ctx.server.http}/split-reveal`
    const base = ctx.tabs.create(url)
    const dragged = ctx.tabs.create(url, { activate: false })
    const dbg = overlay.debugger
    let data: unknown = null
    let dragging = false
    const onMessage = (_e: unknown, method: string, params: { data?: unknown }): void => {
      if (method === 'Input.dragIntercepted') data = params.data
    }
    const zonesShown = (): boolean => win.overlay.openSurfaces().some((s) => s.surface === 'split-zones')
    win.chromeWindow.setSidebarOpen(false)
    try {
      await ctx.chrome.until(`return document.querySelector('.app--sidebar-shown') ? null : true`, 5000, 'the sidebar to hide')
      // The pointer at the edge keeps asking for the reveal; one sent before the chrome has caught up with the
      // hidden sidebar is ignored (on a busy run, after the pin check), so it is asked again, as the pointer would.
      await waitFor(async () => {
        win.send({ type: 'edge-reveal', active: true })
        await sleep(250)
        return (await rect(overlay, '.sidebar-reveal')) !== null
      }, 6000, 'the floating sidebar to open')
      const row =`.sidebar-reveal .tab-row[data-tab-ids~="${dragged.id}"]`
      let prev: Rect | null = null
      await waitFor(async () => {
        const now = await rect(overlay, row)
        const settled = prev !== null && now !== null && Math.abs(now.x - prev.x) < 0.5 && Math.abs(now.y - prev.y) < 0.5
        prev = now
        if (!settled) await sleep(120)
        return settled
      }, 6000, 'the dragged tab’s row in the floating sidebar, at rest').catch(async (err: unknown) => {
        const seen = await overlay.executeJavaScript(`(() => { const r = document.querySelector('.sidebar-reveal'); return JSON.stringify({ reveal: !!r, rows: r ? [...r.querySelectorAll('.tab-row')].map((e) => e.dataset.tabIds) : null, open: ${JSON.stringify(win.overlay.openSurfaces().map((s) => s.surface))} }) })()`, true).catch(() => 'unknown')
        throw new Error(`${err instanceof Error ? err.message : String(err)} (dragged ${dragged.id}, last ${JSON.stringify(prev)}, ${seen})`)
      })
      const from = centre(prev as unknown as Rect)
      dbg.attach('1.3')
      await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })
      dbg.on('message', onMessage)
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 6; i++) await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 3, y: from.y + i * 2, button: 'left', buttons: 1 })
      await waitFor(() => data !== null, 3000, 'the tab drag to start in the floating sidebar')
      dragging = true
      const page = win.tabs.layoutBounds().primary
      const origin = win.window.getContentBounds()
      steerTabDrag({ x: Math.round(origin.x + page.x + page.width * 0.85), y: Math.round(origin.y + page.y + page.height / 2) })
      await waitFor(zonesShown, 3000, 'the split zones over the page')
      let zones: Rect | null = null
      await waitFor(async () => (zones = await rect(overlay, '.split-zones')) !== null && zones.width > 0, 3000, 'the zones to draw')
      const z = zones as unknown as Rect
      const at = { x: Math.round(z.x + z.width * 0.85), y: Math.round(z.y + z.height / 2) }
      await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: at.x, y: at.y, data })
      for (let i = 0; i < 3; i++) await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragOver', x: at.x + i, y: at.y, data })
      await waitFor(async () => (await rect(overlay, '.split-zone--right.split-zone--active')) !== null, 2000, 'the right zone to light up under the drag')
      await dbg.sendCommand('Input.dispatchDragEvent', { type: 'drop', x: at.x, y: at.y, data })
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      dragging = false
      await waitFor(() => ctx.tabs.split()?.secondaryId === dragged.id, 3000, `the dropped tab to open on the right (split ${JSON.stringify(ctx.tabs.split())})`)
      await waitFor(() => !zonesShown(), 3000, 'the zones to go after the drop')
    } finally {
      steerTabDrag(null)
      dbg.off('message', onMessage)
      try {
        if (dragging) await dbg.sendCommand('Input.dispatchDragEvent', { type: 'dragCancel', x: 0, y: 0, data: { items: [], dragOperationsMask: 1 } })
        await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
      } catch {
        // Already detached.
      }
      if (dbg.isAttached()) dbg.detach()
      win.overlay.closeAll((s) => s === 'sidebar-reveal' || s === 'split-zones')
      win.chromeWindow.setSidebarOpen(true)
      ctx.tabs.closeSplit()
      for (const t of [dragged, base]) if (ctx.tabs.find(t.id)) ctx.tabs.close(t.id)
    }
  },
}

export const checks: SmokeCheck[] = [pinByDrag, splitByDrag, splitFromReveal]
export const shots: ShotSpec[] = []
