/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, screen, systemPreferences } from 'electron'
import { UI, type Bounds } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { splitReachAt, splitSideAt, type SplitZonesBlock, type TabDragZone, type TabGhost } from '@shared/tabs'
import type { WindowContext } from './features/types'
import { log } from './log'
import type { ThumbnailCache } from './thumbnails'
import type { WindowManager } from './windows'

// Tear-off, move and drop to split (SH-30). The chrome starts the drag when
// a tab row is dragged; main follows the pointer (screen.getCursorScreenPoint)
// and moves a pre-created, click-through ghost window that grows from a chip
// into a thumbnail with distance. The release decides the result: back on
// the list it was a reorder (the chrome did it), on another window the tab
// moves there, on a split zone it opens beside the active page, and anywhere
// else it opens in a new window at that point.
//
// The split zones are a drop target in the overlay over the page, so a page
// never receives the drop. Once they have seen the drag, only their drop
// splits, on the side they showed: a release there without one (Escape) is
// no split. Each drag ends once; a late call from an earlier drag is ignored.

export interface Point {
  x: number
  y: number
}

/** One window as the drop sees it, in screen coordinates, front-most first. */
export interface DropWindow {
  id: number
  bounds: Bounds
  /** The content card (where split zones are), or null when unknown. */
  content: Bounds | null
  /** Tabs can't change session: private and normal windows don't swap tabs. */
  sameSession: boolean
}

export type SplitZone = 'left' | 'right'

export type DropTarget =
  | { kind: 'list' }
  | { kind: 'move'; windowId: number }
  | { kind: 'split'; windowId: number; side: SplitZone }
  | { kind: 'new-window'; point: Point }
  | { kind: 'none' }

export function contains(r: Bounds, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
}

/** The split zone under the pointer: the outer 40% on each side of the content card. */
export function zoneAt(content: Bounds, p: Point): SplitZone | null {
  if (!contains(content, p)) return null
  return splitSideAt((p.x - content.x) / Math.max(1, content.width))
}

/** How close the pointer is to a zone's outer edge, 0 to 1: zones grow as it nears. */
export function zoneReach(content: Bounds, p: Point): number {
  if (!contains(content, p)) return 0
  return splitReachAt((p.x - content.x) / Math.max(1, content.width))
}

/** The ghost's growth: a chip near the list, a thumbnail about 240 px away. */
export function ghostGrow(list: Bounds | null, p: Point, full = 240): number {
  if (!list) return 1
  const dx = p.x < list.x ? list.x - p.x : p.x > list.x + list.width ? p.x - (list.x + list.width) : 0
  const dy = p.y < list.y ? list.y - p.y : p.y > list.y + list.height ? p.y - (list.y + list.height) : 0
  return Math.max(0, Math.min(1, Math.hypot(dx, dy) / full))
}

/**
 * Decides what a release does. `windows` are front-most first, the source
 * among them. `onList` means the chrome's list took the drop itself.
 */
export function resolveDrop(p: Point, sourceId: number, windows: readonly DropWindow[], opts: { onList: boolean; splitBlock: SplitZonesBlock; tabCount: number }): DropTarget {
  if (opts.onList) return { kind: 'list' }
  const over = windows.find((w) => contains(w.bounds, p))
  if (over) {
    if (!over.sameSession) return { kind: 'none' }
    const zone = over.content && opts.splitBlock === null ? zoneAt(over.content, p) : null
    if (zone) return { kind: 'split', windowId: over.id, side: zone }
    if (over.id !== sourceId) return { kind: 'move', windowId: over.id }
    return { kind: 'none' }
  }
  // Just past a window's edge is a slip, not a tear-off: the floating sidebar opens from the screen's edge,
  // a few px outside a window that stops short of it, and a tab let go there stays.
  if (windows.some((w) => contains(inflate(w.bounds, DETACH_MARGIN_PX), p))) return { kind: 'none' }
  // A window's only tab has nowhere better to go than where it is.
  return opts.tabCount > 1 ? { kind: 'new-window', point: p } : { kind: 'none' }
}

/** How far outside every window a release has to be to open the tab in a new window. */
export const DETACH_MARGIN_PX = 48

function inflate(r: Bounds, by: number): Bounds {
  return { x: r.x - by, y: r.y - by, width: r.width + by * 2, height: r.height + by * 2 }
}

const GHOST_CHIP = { width: 220, height: 36 }
const GHOST_CARD = { width: 300, height: 200 }
/** DS-16: a pinned tile (40 px tall, a grid column wide) plus the ghost's 2 px inset. */
const GHOST_TILE = { width: 68, height: 44 }
/** How much of the way to the tile (or back) the morph goes per 16 ms tick: about 70 ms in all. */
const TILE_STEP = 0.25

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/** One tick of the tile morph toward its target; Reduce Motion jumps there. */
export function stepTile(current: number, overPinned: boolean, reduced: boolean, step = TILE_STEP): number {
  const target = overPinned ? 1 : 0
  if (reduced || !Number.isFinite(current)) return target
  return current < target ? Math.min(target, current + step) : Math.max(target, current - step)
}

/**
 * The ghost window's frame for a growth and a tile mix: a chip at the list,
 * a card further out, and a pinned tile over the pinned grid. The chip and
 * card hang from the pointer (24, 14 in); the tile is centred on it.
 */
export function ghostFrame(p: Point, grow: number, tile: number): Bounds {
  const g = Math.max(0, Math.min(1, Number.isFinite(grow) ? grow : 0))
  const m = Math.max(0, Math.min(1, Number.isFinite(tile) ? tile : 0))
  const w = lerp(lerp(GHOST_CHIP.width, GHOST_CARD.width, g), GHOST_TILE.width, m)
  const h = lerp(lerp(GHOST_CHIP.height, GHOST_CARD.height, g), GHOST_TILE.height, m)
  return { x: Math.round(p.x - lerp(24, GHOST_TILE.width / 2, m)), y: Math.round(p.y - lerp(14, GHOST_TILE.height / 2, m)), width: Math.round(w), height: Math.round(h) }
}

function systemReducesMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings?.().prefersReducedMotion === true
  } catch {
    return false
  }
}

export interface TearOffDeps {
  windows: WindowManager
  preload: string
  uiUrl: () => string
  thumbnails: (win: WindowContext) => ThumbnailCache | undefined
  /** Why the zones are off for this tab (agent control, a replying chat). */
  splitBlock(win: WindowContext, tabId: string): SplitZonesBlock
  broadcast(event: AppEvent): void
  /** Apex's own Reduce Motion setting (the system one is read here too). */
  reduceMotion?: () => boolean
  /** Smoke steers the pointer (screen px); null leaves it to the real one. */
  cursor?: () => Point | null
}

/** How long a release over the zones waits for their drop to say where (it is usually already in). */
export const ZONE_DROP_WAIT_MS = 400

interface Drag {
  /** Sent to the zones in their props; their calls carry it back. */
  session: number
  source: WindowContext
  tabId: string
  list: Bounds | null
  ghost: Omit<TabGhost, 'grow' | 'tile'>
  /** DS-16: the pointer is over the pinned grid (the chrome says so), and how far the ghost has morphed into a tile. */
  overPinned: boolean
  tile: number
  /** Read once per drag: Reduce Motion makes the morph a jump. */
  reduced: boolean
  timer: ReturnType<typeof setInterval>
  /** The zones showing, and the page rect (chrome CSS px) they were opened over. */
  zones: { windowId: number; instanceId: string | null; rect: Bounds } | null
  /** The zones got a dragover: their drop, not the release point, decides a split. */
  zonesSeen: boolean
  /** Released over the zones: waiting for their drop (ZONE_DROP_WAIT_MS at most). */
  awaiting: ReturnType<typeof setTimeout> | null
  watchdog: ReturnType<typeof setTimeout>
}

export class TearOff {
  readonly #deps: TearOffDeps
  #ghost: BrowserWindow | null = null
  #drag: Drag | null = null
  #session = 0

  constructor(deps: TearOffDeps) {
    this.#deps = deps
  }

  /** Pre-creates the ghost so the first drag shows it at once. */
  prewarm(): void {
    this.#ensureGhost()
  }

  start(source: WindowContext, tabId: string, listRect: Bounds | null): void {
    this.cancel()
    const tab = source.tabs.get(tabId)
    const info = source.tabs.info(tab)
    const list = listRect ? this.#toScreen(source, listRect) : null
    const thumbnail = this.#deps.thumbnails(source)?.peek(tabId) ?? null
    this.#drag = {
      session: ++this.#session,
      source,
      tabId,
      list,
      ghost: { title: info.title, favicon: info.favicon, thumbnail },
      overPinned: false,
      tile: 0,
      reduced: (this.#deps.reduceMotion?.() ?? false) || systemReducesMotion(),
      timer: setInterval(() => this.#follow(), 16),
      zones: null,
      zonesSeen: false,
      awaiting: null,
      // A release the chrome never reports (it lost the pointer) must not leave the ghost up.
      watchdog: setTimeout(() => this.cancel(), 30_000),
    }
    this.#deps.broadcast({ type: 'tab-drag', active: true })
    this.#follow()
  }

  end(source: WindowContext, onList: boolean): void {
    const drag = this.#drag
    if (!drag || drag.source !== source || drag.awaiting) return
    const point = this.#cursor()
    const tabId = drag.tabId
    if (!onList && drag.zonesSeen && drag.zones && this.#overZones(drag, point)) {
      // The zones take this drop themselves and say on which side; if none comes (Escape), nothing splits.
      clearInterval(drag.timer)
      this.#hideGhost()
      drag.awaiting = setTimeout(() => this.cancel(), ZONE_DROP_WAIT_MS)
      return
    }
    this.#stop()
    if (!source.tabs.find(tabId)) return
    const windows = this.#dropWindows(source)
    const target = resolveDrop(point, source.id, windows, { onList, splitBlock: this.#deps.splitBlock(source, tabId), tabCount: source.tabs.all().length })
    this.#commit(source, tabId, target)
  }

  cancel(): void {
    if (this.#drag) this.#stop()
  }

  /** The zones of some window got the drag: from now on their drop decides a split. */
  zonesSeen(session: number): void {
    if (this.#drag?.session === session) this.#drag.zonesSeen = true
  }

  /** The drop landed on `into`'s zones, on `side` (null: the middle, or splitting was off). It may come before or after the release. */
  dropOnZone(into: WindowContext, session: number, side: SplitZone | null): void {
    const drag = this.#drag
    if (!drag || drag.session !== session) return
    this.#stop()
    if (!side || !drag.source.tabs.find(drag.tabId) || this.#deps.splitBlock(drag.source, drag.tabId) !== null) return
    this.#commit(drag.source, drag.tabId, { kind: 'split', windowId: into.id, side })
  }

  /** DS-16: the source window's pointer entered or left the pinned grid. Other windows can't steer this drag. */
  over(source: WindowContext, zone: TabDragZone | null): void {
    const drag = this.#drag
    if (!drag || drag.source !== source) return
    drag.overPinned = zone === 'pinned'
  }

  dispose(): void {
    this.cancel()
    if (this.#ghost && !this.#ghost.isDestroyed()) this.#ghost.destroy()
    this.#ghost = null
  }

  /** Applies a drop once the zones and the ghost are already away, so a failure can't leave them up. */
  #commit(source: WindowContext, tabId: string, target: DropTarget): void {
    try {
      this.#apply(source, tabId, target)
    } catch (err) {
      log.warn('tabs', 'A tab drop failed', { error: err instanceof Error ? err.message : String(err), kind: target.kind })
    }
  }

  /** Whether `p` is over the page of the window whose zones are showing. */
  #overZones(drag: Drag, p: Point): boolean {
    const shown = this.#dropWindows(drag.source).find((w) => w.id === drag.zones?.windowId)
    return shown?.content != null && contains(shown.content, p)
  }

  #cursor(): Point {
    return this.#deps.cursor?.() ?? screen.getCursorScreenPoint()
  }

  #apply(source: WindowContext, tabId: string, target: DropTarget): void {
    switch (target.kind) {
      case 'list':
      case 'none':
        return
      case 'move': {
        const into = this.#deps.windows.get(target.windowId)
        if (!into) return
        into.tabs.adopt(source.tabs.release(tabId))
        if (!into.window.isDestroyed()) into.window.focus()
        return
      }
      case 'split': {
        const into = this.#deps.windows.get(target.windowId)
        if (!into) return
        const active = into.tabs.activeId()
        if (into !== source) into.tabs.adopt(source.tabs.release(tabId))
        const partner = active && active !== tabId ? active : into.tabs.recent().find((id) => id !== tabId)
        if (!partner) return
        into.tabs.openSplitWith(tabId, partner)
        // Left and right follow the list; put the dropped page on the side it was dropped.
        const split = into.tabs.split()
        if (split && (target.side === 'left') !== (split.primaryId === tabId)) into.tabs.swapSplit()
        return
      }
      case 'new-window': {
        const id = this.#deps.windows.open('normal')
        const into = this.#deps.windows.get(id)
        if (!into) return
        const blank = into.tabs.all().map((t) => t.id)
        into.tabs.adopt(source.tabs.release(tabId))
        // The new window's own starting tab goes once the moved tab is in.
        for (const b of blank) if (into.tabs.find(b) && into.tabs.all().length > 1) into.tabs.close(b)
        if (!into.window.isDestroyed()) {
          const [w] = into.window.getSize()
          into.window.setPosition(Math.round(target.point.x - (w ?? 800) / 2), Math.round(target.point.y - 20))
        }
        return
      }
    }
  }

  #stop(): void {
    const drag = this.#drag
    if (!drag) return
    this.#drag = null
    clearInterval(drag.timer)
    clearTimeout(drag.watchdog)
    if (drag.awaiting) clearTimeout(drag.awaiting)
    this.#closeZones(drag)
    this.#hideGhost()
    this.#deps.broadcast({ type: 'tab-drag', active: false })
  }

  #hideGhost(): void {
    const ghost = this.#ghost
    if (!ghost || ghost.isDestroyed()) return
    ghost.hide()
    this.#sendGhost(null)
  }

  #follow(): void {
    const drag = this.#drag
    if (!drag) return
    // The dragged tab closed (or moved away) mid-drag: there is nothing left to drop.
    if (!drag.source.tabs.find(drag.tabId)) return this.cancel()
    const p = this.#cursor()
    const grow = ghostGrow(drag.list, p)
    drag.tile = stepTile(drag.tile, drag.overPinned, drag.reduced)
    const ghost = this.#ensureGhost()
    if (ghost) {
      ghost.setBounds(ghostFrame(p, grow, drag.tile))
      this.#sendGhost({ ...drag.ghost, grow, tile: drag.tile })
      if (!ghost.isVisible()) ghost.showInactive()
    }
    this.#updateZones(drag, p)
  }

  #updateZones(drag: Drag, p: { x: number; y: number }): void {
    const over = this.#dropWindows(drag.source).find((w) => contains(w.bounds, p) && w.sameSession && w.content && contains(w.content, p))
    if (!over || !over.content) {
      this.#closeZones(drag)
      return
    }
    const win = this.#deps.windows.get(over.id)
    if (!win) return
    const rect = this.#toWindow(win, over.content)
    // Another window's page, or this page moved or resized under the drag (a layout still settling): they open again over it.
    if (drag.zones && (drag.zones.windowId !== over.id || !sameRect(drag.zones.rect, rect))) this.#closeZones(drag)
    const block = this.#deps.splitBlock(drag.source, drag.tabId)
    const props = { session: drag.session, active: block === null ? zoneAt(over.content, p) : null, block, reach: zoneReach(over.content, p) }
    if (drag.zones) {
      // Without an id the overlay wasn't available: the drop still works, the zones just don't draw.
      if (drag.zones.instanceId) win.overlay.update(drag.zones.instanceId, props)
      return
    }
    // open() resolves only once the surface closes. The host adds it synchronously, so its id is read back
    // right away, for the updates and the close.
    const before = new Set(win.overlay.openSurfaces().map((s) => s.instanceId))
    void win.overlay.open('split-zones', { kind: 'window', rect }, props).catch(() => undefined)
    const instanceId = win.overlay.openSurfaces().find((s) => s.surface === 'split-zones' && !before.has(s.instanceId))?.instanceId ?? null
    drag.zones = { windowId: over.id, instanceId, rect }
  }

  /** Puts the zones away; every split-zones surface goes, so none can outlive the drag. */
  #closeZones(drag: Drag): void {
    if (!drag.zones) return
    drag.zones = null
    for (const w of this.#deps.windows.all()) if (!w.window.isDestroyed()) w.overlay.closeAll((s) => s === 'split-zones')
  }

  /** Every window front-most first (the focused one leads), in screen coordinates. */
  #dropWindows(source: WindowContext): DropWindow[] {
    const all = this.#deps.windows.all().filter((w) => !w.window.isDestroyed() && w.window.isVisible() && !w.window.isMinimized())
    const focused = all.find((w) => w.window.isFocused())
    const ordered = focused ? [focused, ...all.filter((w) => w !== focused)] : all
    return ordered.map((w) => {
      const layout = w.tabs.layoutBounds()
      const content = layout.secondary ? unionBounds(layout.primary, layout.secondary) : layout.primary
      const origin = w.window.getContentBounds()
      return {
        id: w.id,
        bounds: w.window.getBounds(),
        content: content.width > 0 && content.height > 0 ? { x: origin.x + content.x, y: origin.y + content.y, width: content.width, height: content.height } : null,
        sameSession: w.session === source.session && w.kind !== 'popup',
      }
    })
  }

  /** A rect in the chrome's CSS px to screen px. */
  #toScreen(win: WindowContext, r: Bounds): Bounds {
    const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
    const origin = win.window.getContentBounds()
    return { x: origin.x + r.x * zoom, y: origin.y + r.y * zoom, width: r.width * zoom, height: r.height * zoom }
  }

  /** A screen rect to the chrome's CSS px (overlay anchors). */
  #toWindow(win: WindowContext, r: Bounds): Bounds {
    const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
    const origin = win.window.getContentBounds()
    return { x: (r.x - origin.x) / zoom, y: (r.y - origin.y) / zoom, width: r.width / zoom, height: r.height / zoom }
  }

  #sendGhost(ghost: TabGhost | null): void {
    const g = this.#ghost
    if (!g || g.isDestroyed() || g.webContents.isDestroyed()) return
    g.webContents.send(UI.appEvent, { type: 'tab-ghost', ghost } satisfies AppEvent)
  }

  #ensureGhost(): BrowserWindow | null {
    // A ghost that macOS made a full-screen window of has a Space of its own: showing it slid the screen
    // there, black but for the chip (2026-11-12). It can't become one any more; an old one is replaced.
    if (this.#ghost && !this.#ghost.isDestroyed() && this.#ghost.isFullScreen()) this.#ghost.destroy()
    if (this.#ghost && !this.#ghost.isDestroyed()) return this.#ghost
    try {
      const ghost = new BrowserWindow({
        type: 'panel',
        width: GHOST_CHIP.width,
        height: GHOST_CHIP.height,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        backgroundColor: '#00000000',
        webPreferences: { preload: this.#deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
      })
      ghost.setIgnoreMouseEvents(true)
      ghost.setAlwaysOnTop(true, 'screen-saver')
      // skipTransformProcessType keeps the Dock icon still on each call.
      ghost.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      void ghost.loadURL(`${this.#deps.uiUrl()}#ghost`).catch(() => undefined)
      this.#ghost = ghost
      return ghost
    } catch (err) {
      log.warn('tabs', 'The drag ghost could not be created', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }
}

function sameRect(a: Bounds, b: Bounds): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}
