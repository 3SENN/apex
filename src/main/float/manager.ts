/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { Companion } from '@shared/companion'
import { FLOAT, FLOAT_KINDS, FLOAT_SPECS, type FloatEvent, type FloatInitial, type FloatKind, type FloatLanguage, type Placement } from '@shared/float'
import type { ThemeState } from '@shared/theme'
import { checkFloatAccess, parseFloatMethod } from './access'
import type { FloatNativeShim } from './native'
import { clampSize, clampToWorkArea, pickDisplay, placeFloat, rememberPosition, type DisplayLike } from './placement'

// The four always-on-top floats. Each kind has one window, made on
// first open and hidden (never destroyed) on close, so reopening is instant
// and Electron never sees "the last window closed". Placement follows the
// cursor's display or Atelier's, and is redone whenever the displays change.

export interface FloatManagerDeps {
  /** Path of the built float preload (out/preload/float.js). */
  preload: string
  /** The float page's address for a kind (app://atelier/float.html?kind=…, or the dev server). */
  url(kind: FloatKind): string
  theme(): ThemeState
  companion(): Companion | null
  reduceMotion(): boolean
  /** The app language main speaks now. */
  language(): FloatLanguage
  /** The focused (or last) Atelier browser window, for HUD placement. */
  atelierWindow(): BrowserWindow | null
  /** Runs a feature service method through its SERVICE_SCHEMAS tuple. */
  callService(service: string, method: string, args: unknown[]): Promise<unknown>
  /** ATELIER_SMOKE: the meeting card shows after 300 ms instead of 3 s. */
  smoke: boolean
  /** The macOS prevent-activation and canHide calls; null until the addon ships. */
  shim?: FloatNativeShim | null
}

type LocalHandler = (kind: FloatKind, args: unknown[]) => unknown

/** macOS and Windows keep content-protected windows out of screen captures; Linux has no such call. */
export const CONTENT_PROTECTION = process.platform === 'darwin' || process.platform === 'win32'
/** A float that hides for a capture takes a frame or two to leave the screen. */
const CAPTURE_HIDE_MS = 100

interface Slot {
  window: BrowserWindow
  payload: unknown
  ready: boolean
  /** Wanted visible: open() was called and close() wasn't. */
  open: boolean
  showTimer: NodeJS.Timeout | null
  placement: Placement
  size: { width: number; height: number }
  /** Re-entry guard for clamping after a drag. */
  clamping: boolean
}

export class FloatManager extends EventEmitter<{ closed: [kind: FloatKind]; action: [kind: FloatKind, name: string, args: unknown[]] }> {
  readonly #deps: FloatManagerDeps
  readonly #slots = new Map<FloatKind, Slot>()
  /** webContents id to the kind it shows, for the sender check. */
  readonly #owners = new Map<number, FloatKind>()
  readonly #handlers = new Map<string, LocalHandler>()
  readonly #remembered = new Map<FloatKind, NonNullable<Placement['remembered']>>()
  #started = false
  #disposed = false
  #destroying = false
  /** Atelier's own screen captures under way with the floats hidden for them (no content protection). */
  #capturing = 0
  readonly #hiddenForCapture = new Set<FloatKind>()

  constructor(deps: FloatManagerDeps) {
    super()
    this.#deps = deps
  }

  /** Registers the float IPC channels and display listeners; call once after app ready. */
  start(): void {
    if (this.#started) return
    this.#started = true
    ipcMain.handle(FLOAT.invoke, (event, ...raw) => this.#invoke(event, raw))
    ipcMain.on(FLOAT.ready, (event) => {
      const kind = this.#kindOf(event)
      event.returnValue = kind ? { kind, initial: this.#initial(kind) } : null
      if (kind) this.#markReady(kind)
    })
    ipcMain.on(FLOAT.resize, (event, size: unknown) => {
      const kind = this.#kindOf(event)
      if (kind) this.#resize(kind, size)
    })
    ipcMain.on(FLOAT.close, (event) => {
      const kind = this.#kindOf(event)
      if (kind) this.close(kind)
    })
    const replaceAll = (): void => {
      for (const kind of this.#slots.keys()) this.#place(kind)
    }
    screen.on('display-added', replaceAll)
    screen.on('display-removed', replaceAll)
    screen.on('display-metrics-changed', replaceAll)
    // Hidden floats are still windows: once the last browser window closes they
    // go too, so 'window-all-closed' fires as it would without them. They come back on
    // the next open().
    app.on('browser-window-created', (_event, win) => {
      win.once('closed', () => {
        if (this.#destroying) return
        // A window being torn down can still be listed with its webContents already gone
        // (Windows destroys owned windows first when their owner goes), and isn't one that stays.
        const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== win && w.webContents && !this.#owners.has(w.webContents.id))
        if (others.length === 0) this.#destroyWindows()
      })
    })
  }

  open(kind: FloatKind, payload: unknown, placement?: Placement): void {
    if (this.#disposed) return
    const slot = this.#slot(kind)
    slot.payload = payload
    slot.placement = placement ?? {}
    slot.open = true
    this.send(kind, { type: 'payload', payload })
    this.#place(kind)
    if (slot.showTimer) clearTimeout(slot.showTimer)
    const delay = kind === 'meeting-card' && this.#deps.smoke ? 300 : FLOAT_SPECS[kind].showDelayMs
    slot.showTimer = setTimeout(() => {
      slot.showTimer = null
      this.#show(kind)
    }, delay)
  }

  update(kind: FloatKind, payload: unknown): void {
    const slot = this.#slots.get(kind)
    if (!slot) return
    slot.payload = payload
    this.send(kind, { type: 'payload', payload })
  }

  close(kind: FloatKind): void {
    const slot = this.#slots.get(kind)
    if (!slot || !slot.open) return
    slot.open = false
    if (slot.showTimer) clearTimeout(slot.showTimer)
    slot.showTimer = null
    if (!slot.window.isDestroyed()) slot.window.hide()
    this.emit('closed', kind)
  }

  isOpen(kind: FloatKind): boolean {
    return this.#slots.get(kind)?.open ?? false
  }

  send(kind: FloatKind, event: FloatEvent): void {
    const slot = this.#slots.get(kind)
    if (!slot || !slot.ready || slot.window.isDestroyed()) return
    slot.window.webContents.send(FLOAT.event, event)
  }

  /** The kind's window, for callers that need it (the widget's drag). Null before its first open. */
  window(kind: FloatKind): BrowserWindow | null {
    const slot = this.#slots.get(kind)
    return slot && !slot.window.isDestroyed() ? slot.window : null
  }

  /**
   * Runs one of Atelier's own screen captures with every float out of it. Content
   * protection does that on macOS and Windows; without it (Linux) the shown
   * floats hide for the capture and come back after it, and one about to show
   * waits for it. Other apps' screenshots still see them there.
   */
  async keepOutOf<T>(capture: () => Promise<T>): Promise<T> {
    if (CONTENT_PROTECTION) return capture()
    this.#capturing++
    for (const [kind, slot] of this.#slots) {
      if (slot.window.isDestroyed() || !slot.window.isVisible()) continue
      slot.window.hide()
      this.#hiddenForCapture.add(kind)
    }
    try {
      if (this.#hiddenForCapture.size > 0) await new Promise((resolve) => setTimeout(resolve, CAPTURE_HIDE_MS))
      return await capture()
    } finally {
      if (--this.#capturing === 0) {
        const kinds = [...this.#hiddenForCapture]
        this.#hiddenForCapture.clear()
        for (const kind of kinds) this.#show(kind)
      }
    }
  }

  /** Answers a 'kind:action' float method. Unhandled ones arrive as 'action' events. */
  handle(name: string, fn: LocalHandler): () => void {
    this.#handlers.set(name, fn)
    return () => {
      if (this.#handlers.get(name) === fn) this.#handlers.delete(name)
    }
  }

  /** Pushes a theme change to every float (OV-04, live theme). */
  setTheme(theme: ThemeState): void {
    for (const kind of this.#slots.keys()) this.send(kind, { type: 'theme', theme })
  }

  setCompanion(companion: Companion | null): void {
    for (const kind of this.#slots.keys()) this.send(kind, { type: 'companion', companion })
  }

  /** The app language changed: every float relabels. */
  setLanguage(language: FloatLanguage): void {
    for (const kind of this.#slots.keys()) this.send(kind, { type: 'language', language })
  }

  dispose(): void {
    this.#disposed = true
    this.#destroyWindows()
  }

  #destroyWindows(): void {
    this.#destroying = true
    try {
      for (const slot of [...this.#slots.values()]) {
        if (slot.showTimer) clearTimeout(slot.showTimer)
        if (!slot.window.isDestroyed()) slot.window.destroy()
      }
    } finally {
      this.#destroying = false
    }
    this.#slots.clear()
    this.#owners.clear()
  }

  #slot(kind: FloatKind): Slot {
    const existing = this.#slots.get(kind)
    if (existing && !existing.window.isDestroyed()) return existing
    const spec = FLOAT_SPECS[kind]
    const window = new BrowserWindow({
      // Only a panel floats over other apps' full-screen Spaces without side effects.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      show: false,
      width: spec.width,
      height: spec.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      roundedCorners: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hiddenInMissionControl: true,
      skipTaskbar: true,
      visualEffectState: 'active',
      focusable: spec.focusable,
      movable: spec.movable,
      webPreferences: {
        preload: this.#deps.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    window.setAlwaysOnTop(true, 'floating', spec.level)
    // Without skipTransformProcessType this hides Atelier's Dock icon for good.
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    // Floats never appear in screenshots or screen shares, their own included (Linux: keepOutOf, Atelier's own only).
    window.setContentProtection(true)
    const shim = this.#deps.shim
    if (shim) {
      const handle = window.getNativeWindowHandle()
      shim.preventActivation(handle)
      if (spec.survivesHide) shim.setCanHide(handle, false)
    }
    const id = window.webContents.id
    this.#owners.set(id, kind)
    window.on('closed', () => {
      this.#owners.delete(id)
      if (this.#slots.get(kind)?.window === window) this.#slots.delete(kind)
    })
    if (spec.movable) window.on('moved', () => this.#afterMove(kind))
    // Floats never navigate or open windows.
    window.webContents.on('will-navigate', (e) => e.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void window.loadURL(this.#deps.url(kind)).catch(() => undefined)
    const slot: Slot = { window, payload: null, ready: false, open: false, showTimer: null, placement: {}, size: { width: spec.width, height: spec.height }, clamping: false }
    this.#slots.set(kind, slot)
    return slot
  }

  #initial(kind: FloatKind): FloatInitial {
    return {
      theme: this.#deps.theme(),
      payload: this.#slots.get(kind)?.payload ?? null,
      companion: this.#deps.companion(),
      reduceMotion: this.#deps.reduceMotion(),
      language: this.#deps.language(),
    }
  }

  #markReady(kind: FloatKind): void {
    const slot = this.#slots.get(kind)
    if (!slot) return
    slot.ready = true
    if (slot.open && !slot.showTimer) this.#show(kind)
  }

  #show(kind: FloatKind): void {
    const slot = this.#slots.get(kind)
    if (!slot || !slot.open || !slot.ready || slot.window.isDestroyed()) return
    if (this.#capturing > 0) {
      this.#hiddenForCapture.add(kind)
      return
    }
    if (FLOAT_SPECS[kind].focusable) {
      slot.window.show()
      slot.window.webContents.focus()
    } else {
      slot.window.showInactive()
    }
  }

  #display(kind: FloatKind, slot: Slot): DisplayLike {
    const spec = FLOAT_SPECS[kind]
    const which = slot.placement.display ?? spec.placement.display
    const atelier = this.#deps.atelierWindow()
    const preferred =
      which === 'atelier' && atelier && !atelier.isDestroyed()
        ? screen.getDisplayMatching(atelier.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const remembered = slot.placement.remembered ?? this.#remembered.get(kind) ?? null
    return pickDisplay(screen.getAllDisplays(), preferred, remembered)
  }

  #place(kind: FloatKind): void {
    const slot = this.#slots.get(kind)
    if (!slot || slot.window.isDestroyed()) return
    const spec = FLOAT_SPECS[kind]
    const display = this.#display(kind, slot)
    const remembered = slot.placement.remembered ?? this.#remembered.get(kind) ?? null
    const rect = placeFloat(slot.size, display, slot.placement.anchor ?? spec.placement.anchor, slot.placement.margin ?? spec.placement.margin, remembered)
    slot.window.setBounds(rect)
  }

  #resize(kind: FloatKind, raw: unknown): void {
    const slot = this.#slots.get(kind)
    if (!slot || slot.window.isDestroyed() || !raw || typeof raw !== 'object') return
    const { width, height } = raw as { width?: unknown; height?: unknown }
    if (typeof width !== 'number' || typeof height !== 'number') return
    const spec = FLOAT_SPECS[kind]
    slot.size = clampSize({ width, height }, { width: spec.width, height: spec.height }, spec.max)
    const current = slot.window.getBounds()
    const display = this.#display(kind, slot)
    const anchor = slot.placement.anchor ?? spec.placement.anchor
    const keepLeft = this.#remembered.get(kind)?.edge === 'left'
    // Centred floats grow about their centre; edge floats keep their edge. Bottom
    // floats grow upwards, clear of the Dock; the widget grows down into its wrap-up.
    const x = anchor === 'bottom-center' ? current.x + (current.width - slot.size.width) / 2 : keepLeft ? current.x : current.x + current.width - slot.size.width
    const y = anchor === 'right-edge' ? current.y : current.y + current.height - slot.size.height
    // The widget's growth into the wrap-up animates (MV-11); reduced motion snaps.
    slot.window.setBounds(clampToWorkArea({ x, y, ...slot.size }, display.workArea), kind === 'recording' && !this.#deps.reduceMotion())
  }

  #afterMove(kind: FloatKind): void {
    const slot = this.#slots.get(kind)
    if (!slot || slot.clamping || slot.window.isDestroyed()) return
    slot.clamping = true
    try {
      const rect = slot.window.getBounds()
      const display = screen.getDisplayMatching(rect)
      const clamped = clampToWorkArea(rect, display.workArea)
      if (clamped.x !== rect.x || clamped.y !== rect.y) slot.window.setBounds(clamped)
      this.#remembered.set(kind, rememberPosition(clamped, display))
    } finally {
      slot.clamping = false
    }
  }

  /** The kind of the float that sent this, when it came from that float's own main frame. */
  #kindOf(event: IpcMainEvent | IpcMainInvokeEvent): FloatKind | null {
    const kind = this.#owners.get(event.sender.id)
    return kind && event.senderFrame === event.sender.mainFrame ? kind : null
  }

  async #invoke(event: IpcMainInvokeEvent, raw: unknown[]): Promise<unknown> {
    const [method, args] = raw
    const access = checkFloatAccess(this.#owners, { senderId: event.sender.id, mainFrame: event.senderFrame === event.sender.mainFrame }, method)
    if (!access.ok) throw new Error(access.error)
    const list = Array.isArray(args) ? args.slice(0, 16) : []
    const target = parseFloatMethod(method as string)
    if (target.kind === 'service') return this.#deps.callService(target.service, target.method, list)
    const handler = this.#handlers.get(target.name)
    if (handler) return handler(access.kind, list)
    this.emit('action', access.kind, target.name, list)
    return undefined
  }
}

/** Every float kind, for code that walks them. */
export const ALL_FLOAT_KINDS = FLOAT_KINDS
