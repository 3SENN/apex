/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app as electronApp, dialog, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { linksIn, locate as locateItem } from '@shared/bookmarks'
import { UI, type ChromeCommand } from '@shared/ipc'
import type { OmniboxAction, OmniboxCommitResult } from '@shared/omnibox'
import { registerCustomEngines, resolveEngine } from '@shared/searchEngines'
import type { AddressServices, BookmarksServiceAdditions, FindServiceAdditions, PeekServiceAdditions } from '@shared/services/address'
import type { CommandId } from '@shared/shortcuts'
import { isBlankUrl, isDestinationUrl, isInternalUrl } from '@shared/url'
import { addressSurfacesOf, bindAddressSurfaces } from '../addressSurfaces'
import { bookmarkStore } from '../bookmarks'
import { BOOKMARKS_HTML_MAX, exportBookmarksHtml, parseBookmarksHtml } from '../bookmarksHtml'
import { createFind } from '../find'
import { historyStore } from '../history'
import { mainT } from '../i18n/mainT'
import { registerLinkMenu } from '../linkMenu'
import { installLinkGestures, watchTargetUrl } from '../links'
import { LoadProgress } from '../loadProgress'
import { log } from '../log'
import { completeFromHistory, omnibox, omniboxDrafts, runPackCommand } from '../omnibox'
import { createAddressProviders, universalSearch, type AddressSources } from '../omniboxProviders'
import { openWebApp } from '../webApps'
import { bindPageMenuWindow } from '../pageMenu'
import { createSearchSuggest } from '../searchSuggest'
import type { Tab } from '../tabs'
import { zoomPatch } from '../uiZoom'
import { ZoomStore } from '../zoom'
import { createZoomController, type ZoomController } from '../zoomController'
import type { AppContext, Feature, ServiceParts, WindowContext } from './types'

// The address feature: the command bar, find, zoom, links, peek and
// bookmarks. The stores (history, bookmarks) are the bootstrap's instances; zoom
// keeps one store per session (memory-only for private windows).

const OPEN_ALL_MAX = 100

/** Every scheme the bar may open; anything else is an inline error. */
function openable(url: string): boolean {
  return /^(https?|file):/i.test(url) || isBlankUrl(url) || isInternalUrl(url)
}

/** NT-01: a new tab (blank, no atelier:// page): the start surface the chrome draws. */
function isBlankTab(tab: Tab): boolean {
  return tab.internalUrl === null && isBlankUrl(tab.view.webContents.getURL())
}

let zoomRowSource: ZoomController['row'] | null = null
let smokeWindows: (() => readonly WindowContext[]) | null = null

function createAddressFeature(): Feature {
  let ctx: AppContext | null = null
  const zoomStores = new Map<Session, ZoomStore>()
  const loads = new LoadProgress()
  const windows = (): readonly WindowContext[] => ctx?.windows.all() ?? []
  const zoom = createZoomController({
    windows,
    // A session the feature never saw (a sandbox) keeps zoom in memory.
    storeFor: (session) => zoomStores.get(session) ?? zoomStores.set(session, new ZoomStore(null)).get(session) as ZoomStore,
  })
  zoomRowSource = (win) => zoom.row(win)
  smokeWindows = windows
  const find = createFind({ windows, onState: (tabId, win, state) => addressSurfacesOf(win)?.findState(tabId, state) })

  const locate = (tabId: string): { tab: Tab; win: WindowContext } | null => {
    for (const win of windows()) {
      const tab = win.tabs.find(tabId)
      if (tab) return { tab, win }
    }
    return null
  }
  /** ⌘F: main's state, then the tab's find-bar surface. */
  const openFind = async (tabId: string) => {
    const state = await find.open(tabId)
    addressSurfacesOf(locate(tabId)?.win)?.openFind(tabId)
    return state
  }
  const sendCommand = (win: WindowContext | null, command: ChromeCommand): void => {
    if (!win || win.chrome.isDestroyed()) return
    win.chrome.focus()
    win.chrome.send(UI.command, command)
  }

  /** Where a commit opens: this tab, a new tab behind it (⌘Enter) or a new tab in front (⌥Enter). */
  const commit = (app: AppContext, tabId: string, input: string, action: OmniboxAction, where: 'here' | 'background' | 'front'): OmniboxCommitResult => {
    const background = where === 'background'
    const located = locate(tabId)
    const win = located?.win ?? app.windows.focused()
    if (!win) return { ok: false, error: mainT('address.error.noWindow') }
    try {
      switch (action.kind) {
        case 'ask':
          omniboxDrafts.set(tabId, null)
          return { ok: true, ask: action.text }
        case 'command':
          void app.commands.run(action.id, win)
          break
        case 'switch-tab': {
          const owner = locate(action.tabId)
          if (!owner) return { ok: false, error: mainT('address.error.tabClosed') }
          owner.win.window.focus()
          owner.win.tabs.activate(action.tabId)
          break
        }
        case 'open-internal':
          win.tabs.openInternal(action.url, background ? { background: true } : where === 'front' ? { newTab: true } : {})
          break
        case 'pack':
          if (!runPackCommand(win, tabId, action.packId, action.commandId)) return { ok: false, error: mainT('address.error.cantOpen') }
          break
        case 'web-app':
          if (!openWebApp(win, action.appId)) return { ok: false, error: mainT('address.error.cantOpen') }
          break
        case 'navigate': {
          const url = action.url
          if (!openable(url)) return { ok: false, error: mainT('address.error.cantOpen') }
          const history = historyStore()
          if (/^https?:/i.test(url) && history) {
            history.noteTyped(url)
            if (input.trim()) history.notePick(input, url)
          }
          // NT-01: the first web search (or typed site) in a new tab ticks its getting-started item.
          if (where === 'here' && located && /^https?:/i.test(url) && isBlankTab(located.tab)) app.signal('web-searched')
          if (isInternalUrl(url)) win.tabs.openInternal(url, background ? { background: true } : where === 'front' ? { newTab: true } : {})
          else if (background || where === 'front') win.tabs.create(url, { activate: !background, afterId: located?.tab.id })
          else if (located) {
            if (isDestinationUrl(url)) win.tabs.openInternal(url)
            else win.tabs.navigate(located.tab.id, url)
          } else win.tabs.create(url)
          break
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    omniboxDrafts.set(tabId, null)
    return { ok: true }
  }

  const registerCommands = (app: AppContext): (() => void)[] => {
    const offs: (() => void)[] = []
    // Another feature may already own a command; the first registration wins.
    const register = (id: CommandId, run: (win: WindowContext | null) => void | Promise<void>, enabled?: (win: WindowContext | null) => boolean): void => {
      if (app.commands.has(id)) return
      offs.push(app.commands.register(id, run, enabled ? { enabled } : {}))
    }
    const activeWeb = (win: WindowContext | null): Tab | null => {
      const tab = win?.tabs.active() ?? null
      return tab && win && !win.tabs.isChromeDrawn(tab) ? tab : null
    }
    register('focus-address', (win) => sendCommand(win, 'focus-omnibox'))
    register('search-tabs-chats', (win) => sendCommand(win, 'open-universal-search'))
    register('find', (win) => {
      const tab = activeWeb(win)
      if (tab) void openFind(tab.id)
    }, (win) => activeWeb(win) !== null)
    register('find-next', async (win) => {
      const tab = activeWeb(win)
      if (tab) await find.step(tab.id, true)
    }, (win) => activeWeb(win) !== null)
    register('find-previous', async (win) => {
      const tab = activeWeb(win)
      if (tab) await find.step(tab.id, false)
    }, (win) => activeWeb(win) !== null)
    register('bookmark-page', (win) => sendCommand(win, 'bookmark-editor'), (win) => {
      const tab = activeWeb(win)
      return !!tab && /^https?:/i.test(tab.view.webContents.getURL())
    })
    register('bookmark-all-tabs', (win) => {
      const store = bookmarkStore()
      if (!win || !store) return
      const pages = win.tabs.all().filter((t) => !win.tabs.isChromeDrawn(t) && /^https?:/i.test(t.view.webContents.getURL()))
      if (pages.length === 0) return
      const folder = store.createFolder('bar', mainT('address.bookmarks.allTabsFolder', { date: new Date().toLocaleDateString() }))
      for (const t of pages) store.add({ url: t.view.webContents.getURL(), title: t.view.webContents.getTitle(), favicon: t.favicon, parentId: folder.id })
    })
    // ⌘+, ⌘- and ⌘0: per-site page zoom on websites; Atelier pages scale the interface instead (interface zoom, uiZoom).
    const zoomBy = (win: WindowContext | null, delta: 1 | -1 | 0): void => {
      const tab = win?.tabs.active() ?? null
      if (!tab || !win) return
      if (win.tabs.isChromeDrawn(tab)) {
        app.settings.update(zoomPatch(tab.internalUrl ?? tab.view.webContents.getURL(), app.settings.get(), delta).patch)
        return
      }
      if (delta === 0) zoom.reset(tab.id)
      else zoom.step(tab.id, delta)
    }
    register('zoom-in', (win) => zoomBy(win, 1))
    register('zoom-in-equal', (win) => zoomBy(win, 1))
    register('zoom-out', (win) => zoomBy(win, -1))
    register('zoom-reset', (win) => zoomBy(win, 0))
    register('actual-size', (win) => zoomBy(win, 0))
    register('open-bookmarks', (win) => win?.tabs.openInternal('atelier://bookmarks'))
    register('toggle-bookmarks-bar', () => {
      app.settings.update({ bookmarksBar: app.settings.get().bookmarksBar === 'always' ? 'never' : 'always' })
    })
    return offs
  }

  const bookmarkServices = (app: AppContext): BookmarksServiceAdditions => {
    const store = (): NonNullable<ReturnType<typeof bookmarkStore>> => {
      const s = bookmarkStore()
      if (!s) throw new Error('Bookmarks are not available yet.')
      return s
    }
    const faviconFor = (url: string): string | null => {
      for (const win of windows()) for (const t of win.tabs.all()) if (!t.internalUrl && t.view.webContents.getURL() === url) return t.favicon
      return null
    }
    return {
      tree: () => store().tree(),
      add: (input) => store().add({ ...input, favicon: faviconFor(input.url) }),
      createFolder: (parentId, title, index) => store().createFolder(parentId, title, index ?? null),
      update: (id, patch) => store().update(id, patch),
      move: (id, parentId, index) => store().move(id, parentId, index),
      removeItem(id) {
        const removal = store().removeItem(id)
        // SH-48: an open folder panel closes when a folder is deleted.
        if (removal.item.kind === 'folder') {
          for (const win of app.windows.all()) {
            if (!win.window.isDestroyed() && win.overlay.attached) win.overlay.closeAll((s) => s === 'bookmark-folder' || s === 'bookmarks-overflow')
          }
        }
        return removal
      },
      restore: (removal) => store().restore(removal),
      openAll(folderId, options) {
        const folder = locateItem(store().tree(), folderId)?.item
        if (!folder || folder.kind !== 'folder') throw new Error('That folder no longer exists.')
        const win = app.windows.focused()
        if (!win) return []
        let after = win.tabs.activeId() ?? undefined
        const ids: string[] = []
        for (const link of linksIn(folder).slice(0, OPEN_ALL_MAX)) {
          const tab = win.tabs.create(link.url, { activate: false, afterId: after })
          after = tab.id
          ids.push(tab.id)
        }
        if (!options?.background && ids[0]) win.tabs.activate(ids[0])
        return ids
      },
      async exportHtml() {
        const win = app.windows.focused()
        const options = { defaultPath: join(electronApp.getPath('documents'), `${BRAND_NAME} bookmarks.html`), filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }] }
        const target = win ? await dialog.showSaveDialog(win.window, options) : await dialog.showSaveDialog(options)
        if (target.canceled || !target.filePath) return null
        writeFileSync(target.filePath, exportBookmarksHtml(store().tree()), 'utf8')
        return target.filePath
      },
      async importHtml() {
        const win = app.windows.focused()
        const options = { properties: ['openFile' as const], filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }] }
        const picked = win ? await dialog.showOpenDialog(win.window, options) : await dialog.showOpenDialog(options)
        const path = picked.filePaths[0]
        if (picked.canceled || !path) return null
        if (statSync(path).size > BOOKMARKS_HTML_MAX) throw new Error(mainT('address.bookmarks.importTooLarge'))
        const parsed = parseBookmarksHtml(readFileSync(path, 'utf8'), () => randomUUID())
        if (parsed.bar.length === 0 && parsed.other.length === 0 && parsed.skipped === 0) throw new Error(mainT('address.bookmarks.importEmpty'))
        return { added: store().importItems(parsed.bar, parsed.other), skipped: parsed.skipped }
      },
      forUrl: (url) => store().link(url),
    }
  }

  return {
    name: 'address',

    app(app): ServiceParts {
      ctx = app
      const settings = app.settings
      registerCustomEngines(settings.get().customSearchEngines)
      // ST-31: custom engines apply live, without a restart.
      settings.on('changed', (next, previous) => {
        if (next.customSearchEngines !== previous.customSearchEngines) registerCustomEngines(next.customSearchEngines)
      })
      settings.on('changed', (next) => registerCustomEngines(next.customSearchEngines))

      const suggest = createSearchSuggest({
        enabled: () => settings.get().searchSuggestions && !app.smoke,
        engine: () => resolveEngine(settings.get().searchEngine, settings.get().customSearchEngines),
      })
      const sources: AddressSources = {
        settings,
        history: historyStore,
        bookmarks: bookmarkStore,
        windows,
        chats: () => app.maintenance?.chats ?? null,
        commands: app.commands,
        suggest: (text, signal) => suggest.suggest(text, signal),
        platform: process.platform,
      }
      for (const provider of createAddressProviders(sources)) omnibox.registerProvider(provider)
      registerLinkMenu(app)
      installLinkGestures(app.windows)
      registerCommands(app)
      bookmarkStore()?.on('tree', (tree) => app.broadcast({ type: 'bookmark-tree', tree }))

      const focusedId = (): number => app.windows.focused()?.id ?? 0
      const services: AddressServices = {
        zoom: {
          step: (tabId, delta) => zoom.step(tabId, delta),
          reset: (tabId) => zoom.reset(tabId),
          get: (tabId) => zoom.get(tabId),
        },
        omnibox: {
          // The bar lives in the focused window until services route per sender.
          query: (text) => omnibox.query(text, { windowId: focusedId(), signal: new AbortController().signal }),
          complete: (text) => completeFromHistory(historyStore(), text),
          draft: (tabId) => omniboxDrafts.get(tabId),
          setDraft: (tabId, text) => omniboxDrafts.set(tabId, text),
          commit: (tabId, input, action, options) => commit(app, tabId, input, action, options?.background ? 'background' : options?.newTab ? 'front' : 'here'),
          removeHistory: (url) => historyStore()?.remove(url),
          universal: async (text, filter) => universalSearch(sources, text, filter, focusedId()),
        },
      }
      const findServices: FindServiceAdditions = {
        open: (tabId) => openFind(tabId) as unknown as ReturnType<FindServiceAdditions['open']>,
        query: (tabId, text) => find.query(tabId, text),
        step: (tabId, forward) => find.step(tabId, forward) as unknown as ReturnType<FindServiceAdditions['step']>,
        close: (tabId) => find.close(tabId),
        state: (tabId) => find.state(tabId),
      }
      const peekServices: PeekServiceAdditions = {
        showTab: (tabId) => {
          const located = locate(tabId)
          if (!located) throw new Error('That tab is closed.')
          located.win.peek.showTab(tabId)
        },
      }
      return { ...services, find: findServices, bookmarks: bookmarkServices(app), peek: peekServices }
    },

    session(session, info) {
      if (zoomStores.has(session)) return
      const dataDir = ctx?.dataDir
      let store: ZoomStore
      if (info.private || !info.partition.startsWith('persist:') || !dataDir) store = new ZoomStore(null)
      else if (info.partition === 'persist:atelier-web') store = ZoomStore.forDataDir(dataDir)
      else store = new ZoomStore(join(dataDir, `zoom-${info.partition.slice('persist:'.length).replace(/[^a-z0-9-]/gi, '_')}.json`))
      zoomStores.set(session, store)
    },

    window(win) {
      bindPageMenuWindow(win)
      const surfaces = bindAddressSurfaces(win, (tabId) => find.close(tabId))
      win.peek.onChange((state) => surfaces.peekState(state))
      win.tabs.decorate((tab) => {
        const load = loads.info(tab.id)
        return load ? { loadStage: load.loadStage, loadStartedAt: load.loadStartedAt } : {}
      })
    },

    tab(tab, win) {
      const wc = tab.view.webContents
      const restore = (): void => zoom.restore(tab, win)
      // Ctrl+wheel and pinch arrive as zoom-changed; they step like ⌘+ and ⌘-.
      const onWheelZoom = (_e: unknown, direction: 'in' | 'out'): void => {
        try {
          zoom.step(tab.id, direction === 'in' ? 1 : -1)
        } catch (err) {
          log.debug('zoom', 'Zoom step failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      wc.on('did-navigate', restore)
      wc.on('zoom-changed', onWheelZoom)
      const cleanups = [loads.attach(tab, win, (info) => addressSurfacesOf(win)?.load(tab, info)), find.attach(tab, win), watchTargetUrl(tab, win)]
      return () => {
        omniboxDrafts.forget(tab.id)
        addressSurfacesOf(win)?.forget(tab.id)
        for (const fn of cleanups) fn()
        if (!wc.isDestroyed()) {
          wc.off('did-navigate', restore)
          wc.off('zoom-changed', onWheelZoom)
        }
      }
    },
  }
}

export const addressFeature: Feature = createAddressFeature()

/** For the smoke run: the address surfaces open in any window right now. */
export const addressSmoke = {
  surfaces(): string[] {
    return (smokeWindows?.() ?? []).flatMap((w) => (w.window.isDestroyed() || !w.overlay.attached ? [] : w.overlay.openSurfaces().map((s) => s.surface)))
  },
  /** Where the interactive overlay view sits in the window (DIP), or null while it is hidden. */
  overlayBounds(surface: string): { x: number; y: number; width: number; height: number } | null {
    const win = (smokeWindows?.() ?? []).find((w) => !w.window.isDestroyed() && w.overlay.attached && w.overlay.openSurfaces().some((s) => s.surface === surface))
    return win?.overlay.interactiveBounds() ?? null
  },
}

/** The zoom row the main menu shows: the active tab's level and which buttons do anything. */
export function addressZoomRow(win: WindowContext | null): ReturnType<ZoomController['row']> {
  return zoomRowSource?.(win) ?? { percent: 100, canZoomIn: false, canZoomOut: false, isDefault: true, applies: false }
}

/** For the main menu's zoom row and the window's routing: the zoom controller's row state for a window. */
export { createZoomController }
