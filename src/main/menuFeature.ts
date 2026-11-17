/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, app, type WebContents } from 'electron'
import type { MainMenuModel } from '@shared/menuBase'
import { menus } from '@shared/menuModel'
import type { Services } from '@shared/services'
import type { MainMenuServices } from '@shared/services/menus'
import type { CommandId } from '@shared/shortcuts'
import type { CommandRun, CommandOptions } from './commands'
import type { AppContext, WindowContext } from './features/types'
import { log } from './log'
import { showAboutPanel } from './branding'
import { appMenu, developerTools, menuActionHooks, menuSources, savePageAsDialog } from './menu'
import { dialogsWindowServices } from './dialogsFeature'
import { addressZoomRow } from './features/address'
import { NOT_AVAILABLE_YET } from './features/stub'

// The menus' main-side wiring: the main-menu service, the
// commands the Edit and Tools rows own (the menus region of SHORTCUTS plus
// menu-only ones), and the late binding to the merged services, so a command
// reaches the page actions once they are ready.

let services: Services | null = null

/** index.ts hands over the merged services once they exist. */
export function bindMenuServices(merged: Services): void {
  services = merged
  menus.invalidate()
}

const emptyModel = (): MainMenuModel => ({ platform: process.platform, appName: app.name, items: [], theme: 'system', layout: 'sidebar', accent: 'companion', adblock: true, zoomPercent: null })

/** Fills the menu's window source, registers the menus' commands and returns the `menus` service. */
export function setupMainMenu(ctx: AppContext): MainMenuServices['menus'] {
  menuSources.windows = ctx.windows
  menuSources.zoomRow = addressZoomRow
  // Test harnesses hand features a bare context without a registry.
  if (typeof ctx.commands?.register === 'function') registerMenuCommands(ctx)
  menuActionHooks['copy-markdown'] = (win, tabId) => pageActions(win)?.copyAsMarkdown(tabId)
  menuActionHooks.screenshot = (win, tabId) => pageActions(win)?.screenshotToClipboard(tabId)
  // Command availability changed: the menus show the registered states from now on.
  menus.invalidate()
  return {
    mainMenu: () => appMenu()?.mainMenu(ctx.windows.focused()) ?? emptyModel(),
    run: async (itemId) => {
      await appMenu()?.run(itemId, ctx.windows.focused())
    },
    popupTop: (target, x, y) => appMenu()?.popupTop(target, x, y, ctx.windows.focused()),
  }
}

/**
 * The page actions of the window a command came from. The merged service acts
 * on the focused window, which need not be `win` (a menu popped up over a
 * background window, or a command run while another app has focus), and the
 * tab id handed over is `win`'s, so the window's own actions are used.
 */
function pageActions(win: WindowContext | null): Services['pageActions'] | null {
  if (win) {
    try {
      return dialogsWindowServices(win).pageActions
    } catch (err) {
      log.warn('menu', 'The window has no page actions', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return services?.pageActions ?? null
}

const notYet = (err: unknown): boolean => err instanceof Error && err.message === NOT_AVAILABLE_YET

/** The tab a command acts on: the window's active web tab. */
function activeTabId(win: WindowContext | null): string | undefined {
  const tab = win?.tabs.active()
  return tab && !win?.tabs.isChromeDrawn(tab) ? tab.id : undefined
}

function hasWebTab(win: WindowContext | null): boolean {
  const tab = win?.tabs.active()
  return !!tab && !win?.tabs.isChromeDrawn(tab) && /^https?:/i.test(tab.view.webContents.getURL())
}

/** The webContents with keyboard focus: a popup, the page or the chrome. */
function focusedContents(win: WindowContext | null): WebContents | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return null
  if (!win || focused !== win.window) return focused.webContents
  const tab = win.tabs.active()
  if (tab && !win.tabs.isChromeDrawn(tab) && tab.view.webContents.isFocused()) return tab.view.webContents
  return win.chrome
}

/**
 * Registers a command unless its feature already did (registration order
 * follows FEATURES); the menus' fallbacks cover the rest until they are registered.
 */
function claim(ctx: AppContext, id: CommandId, run: CommandRun, opts?: CommandOptions): void {
  if (ctx.commands.has(id)) return
  try {
    ctx.commands.register(id, run, opts)
  } catch (err) {
    log.warn('menu', `Command ${id} was registered twice`, { error: err instanceof Error ? err.message : String(err) })
  }
}

function registerMenuCommands(ctx: AppContext): void {
  const web = { enabled: hasWebTab }
  const page = (name: 'copyUrl' | 'copyMarkdownLink' | 'print' | 'viewSource'): CommandRun => (win) => pageActions(win)?.[name](activeTabId(win))
  claim(ctx, 'copy-url', page('copyUrl'), web)
  claim(ctx, 'copy-markdown-link', page('copyMarkdownLink'), web)
  claim(ctx, 'print', page('print'), web)
  claim(ctx, 'view-source', page('viewSource'), web)
  claim(ctx, 'save-as-pdf', async (win) => void (await pageActions(win)?.saveAsPdf(activeTabId(win))), web)
  claim(ctx, 'share', (win) => pageActions(win)?.share(activeTabId(win)), web)
  claim(
    ctx,
    'save-page',
    async (win) => {
      try {
        await pageActions(win)?.savePage(activeTabId(win))
      } catch (err) {
        // Until the page action is ready, the plain Save Page As dialog does the job.
        if (!notYet(err) || !win) throw err
        await savePageAsDialog(win)
      }
    },
    web,
  )
  claim(ctx, 'paste-match-style', (win) => focusedContents(win)?.pasteAndMatchStyle())
  claim(ctx, 'devtools', (win) => developerTools(win ?? fallbackWindow(), 'devtools'))
  claim(ctx, 'console', (win) => developerTools(win ?? fallbackWindow(), 'console'))
  claim(ctx, 'about', () => showAboutPanel())
  claim(ctx, 'open-history', (win) => win?.tabs.openInternal('atelier://history'))
  claim(ctx, 'show-all-history', (win) => win?.tabs.openInternal('atelier://history'))
  claim(ctx, 'open-downloads', (win) => win?.tabs.openInternal('atelier://downloads'))
}

/** Before the window manager knows a focused window, the developer items act on the first one. */
function fallbackWindow(): { window: BrowserWindow; tabs: WindowContext['tabs'] } {
  const win = menuSources.windows?.all()[0]
  if (!win) throw new Error('No window to act on.')
  return { window: win.window, tabs: win.tabs }
}

interface SourceDeps {
  history: { search(query: string, limit: number): Array<{ url: string; title: string }>; on(event: 'recorded' | 'removed' | 'cleared', fn: () => void): unknown }
  bookmarks: { list(): Array<{ id: string; url: string; title: string; createdAt: number; favicon?: string | null }>; on(event: 'changed', fn: () => void): unknown }
  windows: AppContext['windows']
  isDefaultBrowser(): boolean
}

const DEFAULT_BROWSER_TTL_MS = 10_000

/** Points the menus at the stores they list (index.ts, once at start-up). Later features may replace a source (the bookmark tree). */
export function wireMenuSources(deps: SourceDeps): void {
  // A page's favicon, by origin, from the open tabs and bookmarks (history keeps none).
  const favicons = (): Map<string, string> => {
    const map = new Map<string, string>()
    const add = (url: string, favicon: string | null | undefined): void => {
      if (!favicon) return
      try {
        map.set(new URL(url).origin, favicon)
      } catch {
        // Not a URL: no icon.
      }
    }
    for (const b of deps.bookmarks.list()) add(b.url, b.favicon)
    for (const win of deps.windows.all()) for (const tab of win.tabs.all()) add(tab.view.webContents.getURL(), tab.favicon)
    return map
  }
  const iconFor = (map: Map<string, string>, url: string): { image?: string } => {
    try {
      const image = map.get(new URL(url).origin)
      return image ? { image } : {}
    } catch {
      return {}
    }
  }
  menuSources.visited = (limit) => {
    const icons = favicons()
    return deps.history.search('', limit).map((e) => ({ url: e.url, title: e.title, ...iconFor(icons, e.url) }))
  }
  // A flat list of the bar's bookmarks; the bookmark tree replaces this source with folders.
  menuSources.bookmarks ??= () => {
    const list = deps.bookmarks.list()
    const node = (b: (typeof list)[number]) => ({ kind: 'bookmark' as const, id: b.id, title: b.title, url: b.url, ...(b.favicon ? { image: b.favicon } : {}) })
    return { recent: [...list].sort((a, b) => b.createdAt - a.createdAt).map(node), bar: list.map(node), other: [] }
  }
  menuSources.closed = () => deps.windows.recentlyClosed()
  menuSources.reopenClosed = (index) => {
    try {
      return deps.windows.reopen(index)
    } catch {
      // The window manager's list isn't there yet; the menu falls back to the tab's own reopen.
      return false
    }
  }
  let cached: { value: boolean; at: number } | null = null
  menuSources.isDefaultBrowser = () => {
    if (!cached || Date.now() - cached.at > DEFAULT_BROWSER_TTL_MS) cached = { value: deps.isDefaultBrowser(), at: Date.now() }
    return cached.value
  }
  const refresh = (): void => menus.invalidate()
  deps.history.on('recorded', refresh)
  deps.history.on('removed', refresh)
  deps.history.on('cleared', refresh)
  deps.bookmarks.on('changed', refresh)
  app.on('browser-window-focus', () => {
    cached = null
  })
}
