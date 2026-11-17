/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { EventEmitter } from 'node:events'
import { BrowserWindow, screen } from 'electron'
import { UI, type LayoutMode, type WindowState } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { CHROME_BACKGROUND, type ThemeMode } from '@shared/theme'
import type { WindowStateStore } from './settings'
import type { TabManager } from './tabs'
import type { ThemeController } from './theme'
import { DEFAULT_PROFILE_HUE, profileTokens, type ProfileHue } from '@shared/profile'
import { titleBarWindowOptions } from './system/titleBar'
import { uiOriginOf } from '@shared/url'
import { SidebarPointerWatch, type CssRect } from './sidebarPointer'
import { mainT } from './i18n/mainT'

const isMac = process.platform === 'darwin'

/** Where the traffic lights start, before the chrome measures its header. */
export function defaultButtonPosition(layout: LayoutMode): { x: number; y: number } {
  // DS-05: x 14, y 12 in the 40 px sidebar header, before the renderer reports the slot.
  return layout === 'sidebar' ? { x: 14, y: 12 } : { x: 14, y: 13 }
}

/**
 * The browser window, painted in the resolved mode's chrome colour so nothing
 * flashes before the UI draws. DS-03: a profile window starts in its
 * profile's ground (Stone is the plain ground).
 */
export function createChromeWindow({ preload, mode, layout, hue = DEFAULT_PROFILE_HUE }: { preload: string; mode: ThemeMode; layout: LayoutMode; hue?: ProfileHue }): BrowserWindow {
  return new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: BRAND_NAME,
    backgroundColor: hue === DEFAULT_PROFILE_HUE ? CHROME_BACKGROUND[mode] : profileTokens(hue, mode).ground,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: defaultButtonPosition(layout),
    // DS-05: on macOS the overlay only turns on the Window Controls Overlay API (nothing is drawn); the chrome reads the strip beside the traffic lights from it to measure their real frame.
    ...(isMac ? { titleBarOverlay: true } : {}),
    // Windows and Linux draw their window controls over the chrome, recoloured with the hue and theme.
    ...titleBarWindowOptions(process.platform, { mode, layout, hue }),
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
}

/**
 * Allows a few automatic restarts of the chrome renderer, then gives up so a
 * crash loop can't spin forever. Restarts older than the window are forgotten.
 */
export class CrashBudget {
  readonly #limit: number
  readonly #windowMs: number
  #times: number[] = []

  constructor(limit = 3, windowMs = 60_000) {
    this.#limit = limit
    this.#windowMs = windowMs
  }

  /** Records a failure; true while another automatic retry is allowed. */
  record(now: number): boolean {
    this.#times = [...this.#times.filter((t) => now - t < this.#windowMs), now]
    return this.#times.length <= this.#limit
  }

  /** How many failures are in the current window (for back-off). */
  get count(): number {
    return this.#times.length
  }

  /** Past the limit: automatic retries stopped. */
  get exhausted(): boolean {
    return this.#times.length > this.#limit
  }

  reset(): void {
    this.#times = []
  }
}

/**
 * The page shown when the chrome keeps failing. It is static and script-free;
 * the button is a link back to the UI, which the chrome's navigation guard
 * allows because it is the UI's own origin. System colours follow the theme.
 */
export function recoveryPageUrl(uiUrl: string): string {
  const href = uiUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${BRAND_NAME}</title>
<style>
:root { color-scheme: light dark; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
body { margin: 0; height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 360px; text-align: center; padding: 24px; }
h1 { font-size: 17px; margin: 0 0 6px; }
p { margin: 0 0 18px; opacity: 0.72; }
a { display: inline-block; padding: 8px 16px; border-radius: 8px; background: ButtonFace; color: ButtonText; border: 1px solid GrayText; text-decoration: none; font-weight: 600; }
a:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
</style></head><body><main>
<h1>${mainT('core.mainWindow.recoveryTitle')}</h1>
<p>${mainT('core.mainWindow.recoveryBody')}</p>
<a href="${href}" autofocus>${mainT('core.mainWindow.recoveryRetry')}</a>
</main></body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

interface ChromeWindowOptions {
  window: BrowserWindow
  /** The window's kind; private windows keep no saved state. */
  kind?: 'normal' | 'private' | 'popup' | 'chat'
  /** Stable key for per-window state ('main' for the first window). */
  key: string
  store: WindowStateStore
  tabs: TabManager
  theme: ThemeController
  layout: () => LayoutMode
  /** The chrome UI's address, for reloads after a crash. */
  uiUrl: string
}

// DS-14: the sidebar hover poll lives in sidebarPointer.ts (no Electron import, unit-tested).
export { SIDEBAR_POINTER_POLL_MS, pointerWithin } from './sidebarPointer'

/**
 * Per-window chrome state: the sidebar's open state and a custom name (both
 * saved), full screen and page full screen, the native title, the window
 * background that follows the theme, the traffic-light position and crash
 * recovery for the chrome renderer. Emits 'changed' with the new state.
 */
export class ChromeWindow extends EventEmitter<{ changed: [WindowState] }> {
  readonly #options: ChromeWindowOptions
  readonly #budget = new CrashBudget()
  #state: WindowState
  /** DS-14: while the chrome says the pointer is in the sidebar, main watches for the leave it can miss. */
  readonly #sidebarPointer: SidebarPointerWatch

  constructor(options: ChromeWindowOptions) {
    super()
    this.#options = options
    const { window, store, key, tabs, theme } = options
    const saved = store.get(key)
    this.#state = { sidebarOpen: saved.sidebarOpen, name: saved.name, fullScreen: window.isFullScreen(), pageFullScreen: tabs.pageFullScreen(), focusMode: false, kind: options.kind ?? 'normal' }
    this.#sidebarPointer = new SidebarPointerWatch({
      alive: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
      visible: () => window.isVisible() && !window.isMinimized(),
      cursor: () => screen.getCursorScreenPoint(),
      content: () => window.getContentBounds(),
      zoom: () => window.webContents.getZoomFactor(),
      left: () => window.webContents.send(UI.appEvent, { type: 'sidebar-pointer', inside: false } satisfies AppEvent),
    })
    // DS-14: the poll never outlives the pointer's stay: a blur, hide or minimise ends it (and hides the stamps).
    window.on('blur', () => this.#sidebarPointer.release())
    window.on('hide', () => this.#sidebarPointer.release())
    window.on('minimize', () => this.#sidebarPointer.release())
    window.on('closed', () => this.#sidebarPointer.stop())

    // The chrome's own <title> must not replace the window title.
    window.on('page-title-updated', (event) => event.preventDefault())
    window.on('enter-full-screen', () => this.#set({ fullScreen: true }))
    window.on('leave-full-screen', () => this.#set({ fullScreen: false }))
    tabs.on('page-fullscreen', (active) => this.#set({ pageFullScreen: active }))
    tabs.on('changed', () => this.#updateTitle())
    theme.on('changed', (state) => {
      if (!window.isDestroyed()) window.setBackgroundColor(CHROME_BACKGROUND[state.mode])
    })
    this.#guardChrome()
    this.#updateTitle()
  }

  state(): WindowState {
    return { ...this.#state }
  }

  setSidebarOpen(open: boolean): void {
    if (this.#state.sidebarOpen === open) return
    // A private window's layout is never written.
    if (this.#options.kind !== 'private') this.#options.store.update(this.#options.key, { sidebarOpen: open })
    this.#set({ sidebarOpen: open })
  }

  /** Focus mode: the chrome draws nothing, the page fills the window. */
  setFocusMode(on: boolean): void {
    this.#set({ focusMode: on })
  }

  toggleSidebar(): void {
    this.setSidebarOpen(!this.#state.sidebarOpen)
  }

  setName(name: string | null): void {
    const next = name?.trim().slice(0, 80) || null
    if (this.#options.kind !== 'private') this.#options.store.update(this.#options.key, { name: next })
    this.#set({ name: next })
    this.#updateTitle()
  }

  /** macOS: moves the traffic lights; the position is in the chrome's CSS pixels. */
  setButtonPosition(position: { x: number; y: number } | null): { x: number; y: number } | null {
    const { window } = this.#options
    if (!isMac || window.isDestroyed()) return null
    const zoom = window.webContents.getZoomFactor() || 1
    window.setWindowButtonPosition(position
      ? { x: Math.round(position.x * zoom), y: Math.round(position.y * zoom) }
      : defaultButtonPosition(this.#options.layout()))
    // DS-05: the margin AppKit actually took, back in CSS px, so the chrome can measure the real frame from it.
    const applied = window.getWindowButtonPosition()
    return applied ? { x: applied.x / zoom, y: applied.y / zoom } : null
  }

  /**
   * DS-14: the chrome reports the pointer entering the sidebar (its rect) or
   * leaving it (null). Moving straight from the sidebar into a native page
   * view, onto an overlay or out of the window can swallow the DOM's
   * pointerleave, so while the pointer is in, main checks the cursor and tells
   * the chrome once it has left; the trailing stamps then hide.
   */
  trackSidebarPointer(rect: CssRect | null): void {
    this.#sidebarPointer.track(rect)
  }

  /** macOS: shows or hides the traffic lights (hidden with the collapsed sidebar). */
  setButtonsVisible(visible: boolean): void {
    const { window } = this.#options
    if (!isMac || window.isDestroyed()) return
    window.setWindowButtonVisibility(visible)
  }

  #set(patch: Partial<WindowState>): void {
    const next = { ...this.#state, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.#state)) return
    this.#state = next
    this.emit('changed', this.state())
  }

  /** The window title follows the active tab, or the window's own name. */
  #updateTitle(): void {
    const { window, tabs } = this.#options
    if (window.isDestroyed()) return
    const active = tabs.active()
    const rail = tabs.snapshot().rail
    const title = this.#state.name ?? rail?.title ?? (active ? tabs.info(active).title : null) ?? BRAND_NAME
    if (window.getTitle() !== title) window.setTitle(title)
  }

  /**
   * One renderer draws the sidebar, toolbar and every Atelier page, so a crash
   * or a failed load blanks the whole window. Reload it automatically a few
   * times, then show a static page with a retry link.
   */
  #guardChrome(): void {
    const { window, tabs, uiUrl } = this.#options
    const wc = window.webContents
    const uiOrigin = uiOriginOf(uiUrl)
    const isUi = (url: string): boolean => uiOrigin !== null && uiOriginOf(url) === uiOrigin
    const recover = (): void => {
      if (window.isDestroyed()) return
      if (this.#budget.record(Date.now())) {
        const delay = 300 * this.#budget.count
        setTimeout(() => {
          if (!window.isDestroyed()) void wc.loadURL(uiUrl).catch(() => undefined)
        }, delay)
      } else {
        // Page views draw above the chrome; hide them so the notice shows.
        tabs.setHidden('chrome-down', true)
        void wc.loadURL(recoveryPageUrl(uiUrl)).catch(() => undefined)
      }
    }
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') recover()
    })
    wc.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      // -3 is an aborted load (a newer navigation replaced it), not a failure.
      if (isMainFrame && code !== -3 && isUi(url)) recover()
    })
    wc.on('unresponsive', () => console.warn(`The ${BRAND_NAME} window is not responding.`))
    // A reloaded chrome takes its holds again; the old renderer's would leave pages hidden.
    wc.on('did-start-loading', () => {
      if (isUi(wc.getURL()) || wc.getURL() === '') tabs.resetChromeState()
    })
    // The retry link on the recovery page navigates back to the UI while getURL() still names the notice,
    // so the new chrome's start is caught by its target address too.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && isUi(details.url)) tabs.resetChromeState()
    })
    wc.on('did-finish-load', () => {
      if (!isUi(wc.getURL())) return
      tabs.setHidden('chrome-down', false)
      // A manual retry from the notice starts a fresh budget.
      if (this.#budget.exhausted) this.#budget.reset()
    })
  }
}
