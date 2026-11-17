/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import {
  BrowserWindow,
  app as electronApp,
  nativeTheme,
  powerSaveBlocker,
  screen,
  webContents as allWebContents,
  type Event as ElectronEvent,
  type HandlerDetails,
  type Input,
  type WebContents,
  type WindowOpenHandlerResponse,
} from 'electron'
import type { DialogSpec } from '@shared/dialogs'
import { UI, type Bounds } from '@shared/ipc'
import type { Rect } from '@shared/overlay'
import type { Services } from '@shared/services'
import { formatKeys, shortcutById, type CommandId, type ShortcutId } from '@shared/shortcuts'
import type { SavedWindow } from '@shared/windows'
import { privateQuitEnding, privateQuitGate, privateWindowEnding } from './agent/privateClose'
import type { CommandOptions, CommandRun } from './commands'
import { commands } from './commands'
import { dialogs, toasts } from './dialogs'
import { registerDockMenu } from './dockMenu'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import type { IpcWindow } from './ipc'
import { setIpcWindowRouter } from './ipc'
import { EdgeRevealPoller, KeyStateMachine } from './keyState'
import { log } from './log'
import { onSessionEnd } from './system/sessionEnd'
import { appMenu } from './menu'
import { registerOverlayIpc } from './overlayHost'
import { registerPageMenuSection } from './pageMenu'
import { gestures } from './popupBlocker'
import { consultPopupPolicies } from './popupPolicy'
import { createPopupWindow, popups, type PopupDeps } from './popups'
import { KeepAwake } from './powerSave'
import { SESSION_FILE, SessionWriter, keepingLastWindows, readSessionFile, sessionRestore } from './sessionRestore'
import { setServiceRouter } from './services'
import { setOverlayLayers } from './smokeKit'
import type { SettingsStore } from './settings'
import { routeShortcut, shortcuts, type InputSource } from './shortcuts'
import type { Tab } from './tabs'
import type { ThemeController } from './theme'
import { createWindowContext, restoreSaved, type WindowFactoryDeps } from './windowContext'
import { applyWindowMaterial, windowMaterial } from './windowMaterial'
import { CloseCoalescer, closeTarget, needsCloseConfirm, type WindowManager } from './windows'

// The app wiring. index.ts builds the
// first window and the app-wide stores; this attaches the first window's
// overlay host, routes every window's UI, service and overlay IPC from its
// sender, builds later windows, restores and writes session.json, routes
// keys (interceptors, key state, the table), registers the app's own commands, the
// Dock menu, keep-awake and the quit and close warnings, and opens popups.

export interface CoreDeps {
  windows: WindowManager
  first: WindowContext
  firstServices: Services
  firstIpc: IpcWindow
  /** What createWindowContext needs, apart from the app-wide services. */
  factory: Omit<WindowFactoryDeps, 'appServices'>
  settings: SettingsStore
  theme: ThemeController
  dataDir: string
  smoke: boolean
  /** Chats and routines working right now (keep awake, the quit warning). */
  busyCount(): number
  /** Subscribes to changes of busyCount. */
  onBusyChange(fn: () => void): void
  /** The companion working in an agent-controlled tab. */
  agentName(tab: Tab): string
}

export interface CoreHandle {
  /** Restores session.json into the first window and opens the rest; false when nothing was restored. */
  restoreSession(): boolean
  /** setWindowOpenHandler for every webContents (links, popups, SH-62). */
  windowOpen(contents: WebContents, details: HandlerDetails): WindowOpenHandlerResponse
  servicesOf(win: WindowContext): Services
  windows: WindowManager
}

/** Scripted popups keep window.opener; ordinary links become tabs. */
export const POPUP_OPTIONS = {
  width: 520,
  height: 700,
  autoHideMenuBar: true,
  // nodeIntegrationInSubFrames: session frame preloads (the chrome surface, src/main/chromeSurface.ts) run in the
  // popup's iframes too, as in a tab's. A popup has no page preload, so nothing else of Atelier's goes in.
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false },
}

let started: CoreHandle | null = null

/** The running core, once index.ts started it. */
export function core(): CoreHandle | null {
  return started
}

export function startCore(deps: CoreDeps): CoreHandle {
  const { windows, first, settings, theme, smoke } = deps
  const servicesOf = (win: WindowContext): Services => (win.id === first.id ? deps.firstServices : (windows.extras(win.id)?.services ?? deps.firstServices))
  const ipcOf = (win: WindowContext): IpcWindow => {
    if (win.id === first.id) return deps.firstIpc
    const extras = windows.extras(win.id)
    return { ui: win.chrome, tabs: win.tabs, peek: win.peek, webSession: win.session, initialState: extras?.initialState ?? deps.firstIpc.initialState, sendEvent: (e) => win.send(e) }
  }

  // ---- the first window's overlay tiers, and every window's overlay IPC ----
  if (!first.overlay.attached) first.overlay.attach({ window: first.window, chrome: first.chrome, tabs: first.tabs, uiUrl: deps.factory.uiUrl, preload: deps.factory.preloadUi })
  registerOverlayIpc({
    // The chrome opens surfaces; so may a surface itself (a menu row opening a dialog).
    chromeHost: (event) => {
      const frame = event.senderFrame
      for (const w of windows.all()) {
        if (w.chrome.isDestroyed()) continue
        if (w.chrome === event.sender && frame !== null && frame === w.chrome.mainFrame) return w.overlay
        if (w.overlay.ownsWebContents(event.sender.id) && frame === event.sender.mainFrame) return w.overlay
      }
      return null
    },
    overlayHost: (sender) => windows.all().find((w) => w.overlay.ownsWebContents(sender.id))?.overlay ?? null,
    tabOf: (sender) => {
      for (const w of windows.all()) {
        const tab = w.tabs.byWebContents(sender)
        if (tab) return { host: w.overlay, tabId: tab.id }
      }
      return null
    },
  })

  // ---- every UI channel and service routes from its sender ----
  // The tab-drag ghost (tearOff.ts) belongs to no window: it reads the front window's state, as popup strips do.
  const isGhost = (event: { sender: Electron.WebContents; senderFrame: unknown }): boolean =>
    event.senderFrame === event.sender.mainFrame && event.sender.getURL() === `${deps.factory.uiUrl}#ghost`
  setServiceRouter((event) => {
    const win = windows.fromUiSender(event.sender, event.senderFrame) ?? (isGhost(event) ? windows.focused() : null)
    return win ? servicesOf(win) : null
  })
  setIpcWindowRouter((event) => {
    const win = windows.fromUiSender(event.sender, event.senderFrame)
    if (win) return ipcOf(win)
    // A popup's origin strip reads the theme of the window in front (OV-04).
    if (popups.stripOwner(event.sender.id) && event.senderFrame === event.sender.mainFrame) {
      const front = windows.focused()
      return front ? ipcOf(front) : null
    }
    // So does the tab-drag ghost: without the front window's initial state its page threw before it drew
    // anything (main.tsx and the chrome's stores read it on load).
    if (isGhost(event)) {
      const front = windows.focused()
      return front ? ipcOf(front) : null
    }
    return null
  })

  // ---- later windows ----
  windows.setFactory((opts) => {
    const created = createWindowContext({ ...deps.factory, appServices: () => deps.firstServices }, { ...opts, bounds: visibleBounds(opts.bounds) })
    wireWindow(created.win)
    return { win: created.win, services: created.services, initialState: created.initialState }
  })

  // ---- session restore ----
  const sessionPath = join(deps.dataDir, SESSION_FILE)
  // Windows and Linux: the last window's tabs stay the session after its X quits Atelier (keepingLastWindows).
  const writer = new SessionWriter(sessionPath, keepingLastWindows(() => windows.serialize(), process.platform !== 'darwin'))
  let restoring = true
  const scheduleWrite = (): void => {
    if (!restoring && !smoke && !windows.quitting) writer.schedule()
  }
  sessionRestore.setWriter(() => writer.flush())
  windows.onChange(scheduleWrite)

  // ---- per-window wiring: key state, edge reveal, the fullscreen notice ----
  const keyStates = new Map<number, KeyStateMachine>()
  function wireWindow(win: WindowContext): void {
    const keys = new KeyStateMachine({
      emit: (event) => win.send(event),
      tap: (delta) => (delta === 1 ? win.tabs.flipRecent() : win.tabs.step(-1)),
    })
    keyStates.set(win.id, keys)

    const edge = new EdgeRevealPoller({
      cursor: () => screen.getCursorScreenPoint(),
      content: () => (win.window.isDestroyed() ? null : win.window.getContentBounds()),
      exitWidth: () => Math.round((settings.get().sidebarWidth + 16) * zoomOf(win)),
      emit: (active) => win.send({ type: 'edge-reveal', active }),
    })
    const syncEdge = (): void => {
      if (win.window.isDestroyed()) return
      const state = win.chromeWindow.state()
      const hidden = settings.get().layout === 'sidebar' && (!state.sidebarOpen || state.focusMode === true)
      edge.setPolling(hidden && win.window.isFocused() && !win.window.isMinimized() && !state.pageFullScreen)
    }
    syncEdge()
    win.chromeWindow.on('changed', () => {
      syncEdge()
      scheduleWrite()
    })
    const onSettings = (): void => syncEdge()
    settings.on('changed', onSettings)
    win.window.on('focus', syncEdge)
    win.window.on('blur', () => {
      keys.blur()
      syncEdge()
    })
    win.window.on('minimize', syncEdge)
    win.window.on('restore', syncEdge)
    for (const event of ['moved', 'resized', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.window.on(event as 'moved', scheduleWrite)

    // OV-13: the fullscreen notice names the site, then fades on its own.
    win.tabs.on('page-fullscreen', (active: boolean) => {
      win.overlay.closeAll((s) => s === 'fullscreen-notice')
      if (!active) return
      const tab = win.tabs.active()
      void win.overlay.open('fullscreen-notice', windowAnchor(win), { host: tab ? hostOf(tab.view.webContents.getURL()) : null }).catch(() => undefined)
    })

    // A page that goes out of view never hears pointerleave, so a tooltip it showed would stay over the next page.
    let shownPage = ''
    const dropStaleTooltips = (): void => {
      const tab = win.tabs.active()
      const page = `${tab?.id ?? ''}|${win.tabs.rail() ?? ''}|${tab?.internalUrl ?? ''}`
      if (page === shownPage) return
      shownPage = page
      if (!win.window.isDestroyed() && win.overlay.attached) win.overlay.closeAll((s) => s === 'tooltip')
    }
    win.tabs.on('activated', dropStaleTooltips)
    win.tabs.on('changed', dropStaleTooltips)

    // The material is known before the chrome listens, so a loaded chrome hears it again.
    win.chrome.on('did-finish-load', () => win.send({ type: 'window-material', material: windowMaterial(process.platform, nativeTheme.prefersReducedTransparency) }))

    win.window.once('closed', () => {
      keys.dispose()
      edge.dispose()
      keyStates.delete(win.id)
      settings.off('changed', onSettings)
    })
  }
  wireWindow(first)
  applyWindowMaterial(first.window, (material) => first.send({ type: 'window-material', material }))

  // ---- the ShortcutRouter on every chrome, overlay and tab webContents ----
  const routed = new WeakSet<WebContents>()
  const route = (contents: WebContents): void => {
    if (routed.has(contents)) return
    routed.add(contents)
    contents.on('before-input-event', (event, input) => onInput(event, input, contents))
  }
  for (const wc of allWebContents.getAllWebContents()) route(wc)
  electronApp.on('web-contents-created', (_e, wc) => route(wc))

  function onInput(event: ElectronEvent, input: Input, contents: WebContents): void {
    const win = windows.fromWebContents(contents.id)
    // Interceptors first (the voice chord), in every webContents.
    if (shortcuts.intercept(input, contents, win)) {
      event.preventDefault()
      return
    }
    if (!win) return
    if (keyStates.get(win.id)?.input(input)) {
      event.preventDefault()
      return
    }
    const source: InputSource = contents === win.chrome ? 'chrome' : win.overlay.ownsWebContents(contents.id) ? 'overlay' : 'page'
    const tab = (source === 'page' ? win.tabs.byWebContents(contents) : null) ?? win.tabs.active()
    const decision = routeShortcut(input, { source, platform: process.platform, website: !!tab && !win.tabs.isChromeDrawn(tab), agentControlled: tab?.agentControlled === true })
    if (decision.kind === 'pass') return
    event.preventDefault()
    // Holding ⌘W repeats the key; one press closes one thing (SH-26).
    if (input.isAutoRepeat && (decision.id === 'close-tab' || decision.id === 'close-window')) return
    if (decision.kind === 'run') runShortcut(decision.id, win)
    else if (tab) void toasts.show(win, { kind: 'info', text: mainT('core.agent.takeOverFirst', { name: deps.agentName(tab) }), tabId: tab.id }).catch(() => undefined)
  }

  /** Zoom keys go to the per-site zoom on websites and the interface zoom on chrome-drawn pages. */
  function runShortcut(id: ShortcutId, win: WindowContext): void {
    const zoomDelta = id === 'zoom-in' || id === 'zoom-in-equal' ? 1 : id === 'zoom-out' ? -1 : id === 'zoom-reset' ? 0 : null
    if (zoomDelta !== null && !commands.has(id)) {
      const services = servicesOf(win) as Partial<Services>
      const tab = win.tabs.active()
      try {
        if (tab && !win.tabs.isChromeDrawn(tab) && services.zoom) {
          if (zoomDelta === 0) services.zoom.reset(tab.id)
          else services.zoom.step(tab.id, zoomDelta as 1 | -1)
          return
        }
        if (services.uiZoom) {
          if (zoomDelta === 0) services.uiZoom.reset()
          else services.uiZoom.step(zoomDelta as 1 | -1)
          return
        }
      } catch (err) {
        log.warn('shortcuts', `Zoom ${id} failed`, { error: err instanceof Error ? err.message : String(err) })
      }
    }
    const menu = appMenu()
    void (menu ? menu.run(id, win) : commands.run(id, win))
  }

  // ---- the app's own commands ----
  const claim = (id: CommandId, run: CommandRun, opts?: CommandOptions): void => {
    if (commands.has(id)) return
    try {
      commands.register(id, run, opts)
    } catch (err) {
      log.warn('commands', `Command ${id} was registered twice`, { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const target = (w: WindowContext | null): WindowContext | null => w ?? windows.focused()
  claim('new-window', () => void windows.open('normal'))
  claim('new-private-window', () => void windows.open('private'))
  claim('close-window', (w) => {
    const popup = popups.focused()
    if (popup) return popup.window.close()
    target(w)?.window.close()
  })
  // NS-04: false when nothing was closed, so the command plays the failure cue.
  claim('reopen-closed', () => windows.reopen())

  // SH-26: one press closes one target, in order; an intercept so it runs before any other feature's.
  const coalesce = new CloseCoalescer()
  const closeInOrder = (w: WindowContext | null): void => {
    if (!coalesce.accept(Date.now())) return
    const win = target(w)
    const focused = BrowserWindow.getFocusedWindow()
    const popup = popups.focused()
    const managed = focused ? windows.all().some((x) => x.window === focused) : false
    const kind = closeTarget({
      popupFocused: popup !== null,
      otherWindowFocused: !!focused && !managed && popup === null,
      // The router and the menus hand over the window the key was pressed in.
      windowFocused: !!win && !win.window.isDestroyed(),
      peekOpen: win?.peek.isOpen() ?? false,
      rail: win?.tabs.rail() != null,
      selection: win?.tabs.selection().length ?? 0,
      activeTab: win?.tabs.activeId() != null,
    })
    switch (kind) {
      case 'popup':
        return popup?.window.close()
      case 'other-window':
        return focused?.close()
      case 'peek':
        return win?.peek.close()
      case 'rail':
        return win?.tabs.leaveRail()
      case 'selection':
        return void win?.tabs.closeSelection()
      case 'tab': {
        const id = win?.tabs.activeId()
        const tab = id ? win?.tabs.find(id) : undefined
        if (!win || !id || !tab) return
        if (tab.agentControlled) {
          void toasts.show(win, { kind: 'info', text: mainT('core.agent.takeOverFirst', { name: deps.agentName(tab) }), tabId: id }).catch(() => undefined)
          return
        }
        // A chat window's last tab is the window itself.
        if (win.kind === 'chat' && win.tabs.all().length === 1) return win.window.close()
        // The last tab leaves a fresh new tab (keepOne); focus returns to the most recent tab.
        win.tabs.close(id)
        return
      }
      case 'none':
        return
    }
  }
  claim('close-tab', closeInOrder)
  commands.intercept('close-tab', { when: () => true, run: closeInOrder })

  // SH-67: the shortcuts sheet, toggled.
  claim('shortcuts-sheet', (w) => {
    const win = target(w)
    if (!win) return
    if (win.overlay.openSurfaces().some((s) => s.surface === 'shortcuts-sheet')) return win.overlay.closeAll((s) => s === 'shortcuts-sheet')
    const runtime = shortcuts.runtime().map((r) => ({ id: r.id, title: r.title.slice(0, 200), accelerator: r.accelerator, owner: r.owner }))
    void win.overlay.open('shortcuts-sheet', windowAnchor(win), { platform: process.platform, runtime }).catch(() => undefined)
  })

  // Focus mode, a chromeless page.
  claim(
    'focus-mode',
    (w) => {
      const win = target(w)
      if (!win) return
      const on = win.chromeWindow.state().focusMode !== true
      win.chromeWindow.setFocusMode(on)
      win.send({ type: 'focus-mode', on })
      // The page covers the whole window, so the way back out is a toast above it.
      if (!on) return
      const def = shortcutById('focus-mode')
      const keys = def ? formatKeys(def, process.platform).join(process.platform === 'darwin' ? '' : '+') : ''
      void toasts
        .show(win, { kind: 'info', text: mainT('core.focusMode.on', { keys }), action: { id: 'exit-focus-mode', label: mainT('core.focusMode.exit') }, durationMs: 6000 })
        .then((outcome) => {
          if (outcome === 'action' && !win.window.isDestroyed()) {
            win.chromeWindow.setFocusMode(false)
            win.send({ type: 'focus-mode', on: false })
          }
        })
        .catch(() => undefined)
    },
    { checked: (w) => target(w)?.chromeWindow.state().focusMode === true },
  )

  // ST-22: warn before quitting.
  claim('quit', async (w) => {
    const win = target(w)
    if (smoke || !settings.get().warnBeforeQuit || !win) return electronApp.quit()
    const result = await dialogs.show(win, quitDialog(deps.busyCount()))
    if (result.button !== 'quit') return
    if (result.checked) settings.update({ warnBeforeQuit: false })
    electronApp.quit()
  })

  // ST-22: closing a window with several unpinned tabs asks first.
  const asking = new Set<number>()
  windows.setCloseGuard((win) => {
    if (smoke) return false
    const unpinnedTabs = win.tabs.all().filter((t) => !t.pinned).length
    const several = needsCloseConfirm({ enabled: settings.get().confirmCloseTabs === true, kind: win.kind, unpinnedTabs })
    // CH-30: a private chat with content in one of its tabs asks too (last, so nothing ends before the final answer).
    const privateChats = privateWindowEnding(win)
    if (!several && !privateChats) return false
    if (asking.has(win.id)) return true
    asking.add(win.id)
    void (async () => {
      if (several) {
        const result = await dialogs.show(win, closeWindowDialog(unpinnedTabs))
        if (result.button !== 'close') return
        if (result.checked) settings.update({ confirmCloseTabs: false })
      }
      if (privateChats && !(await privateChats.ask())) return
      if (privateChats) win.window.once('closed', () => privateChats.end())
      windows.closeNow(win.id)
    })()
      .catch(() => undefined)
      .finally(() => asking.delete(win.id))
    return true
  })

  // OV-13: Exit full screen in the page menu (order 40).
  registerPageMenuSection({
    id: 'core:fullscreen',
    order: 40,
    build: (_params, tab, win) =>
      win.tabs.pageFullScreen()
        ? [
            {
              label: mainT('core.fullscreen.exit'),
              click: () => void tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'document.fullscreenElement && document.exitFullscreen()' }]).catch(() => undefined),
            },
          ]
        : [],
  })

  // SH-60: the Dock menu.
  if (process.platform === 'darwin') registerDockMenu((id) => windows.focus(id))

  // ST-22: keep the Mac awake while a chat or routine works (off by default).
  const keepAwake = new KeepAwake({ start: (type) => powerSaveBlocker.start(type), stop: (id) => powerSaveBlocker.stop(id), isStarted: (id) => powerSaveBlocker.isStarted(id) })
  const refreshAwake = (): void => keepAwake.update(settings.get().keepAwake === true, deps.busyCount())
  settings.on('changed', refreshAwake)
  deps.onBusyChange(refreshAwake)
  setInterval(refreshAwake, 10_000).unref()

  // OV-04: popup strips follow the theme too.
  theme.on('changed', (state) => {
    for (const strip of popups.strips()) strip.send(UI.appEvent, { type: 'theme', theme: state })
  })

  // CH-30: quitting with a private chat that has content asks once, for every window, ahead of
  // every other before-quit listener; they leave a quit it holds alone.
  electronApp.prependListener(
    'before-quit',
    privateQuitGate({
      ending: privateQuitEnding,
      window: () => {
        const win = windows.focused() ?? windows.all()[0] ?? null
        if (win && !win.window.isDestroyed()) {
          if (!win.window.isVisible()) win.window.show()
          windows.focus(win.id)
        }
        return win
      },
      // An update installing quits on its own terms (it already set quitting).
      skip: () => smoke || windows.quitting,
      quit: () => electronApp.quit(),
    }),
  )

  const quitting = (): void => {
    keepAwake.dispose()
    if (!smoke && !restoring) void writer.flush()
    // Windows closing one by one must not shrink the saved session, or land on the reopen stack.
    writer.freeze()
    windows.setQuitting(true)
  }
  electronApp.on('before-quit', (event) => {
    if (event.defaultPrevented) return
    quitting()
  })
  // Windows shutting down or signing out sends no before-quit (system/sessionEnd.ts).
  onSessionEnd(quitting)

  // ---- popups (SH-62) ----
  const popupDeps: PopupDeps = {
    uiUrl: deps.factory.uiUrl,
    preload: deps.factory.preloadUi,
    mode: () => theme.state().mode,
    returnFocus: (opener) => {
      const win = windows.fromWebContents(opener.id)
      if (!win || win.window.isDestroyed()) return
      const tab = win.tabs.byWebContents(opener)
      // An agent's sign-in popup closing leaves its out-of-sight tab where it is.
      if (tab && agentOutOfSight(win, tab)) return
      if (tab) win.tabs.activate(tab.id)
      win.window.focus()
      opener.focus()
    },
  }

  const windowOpen = (contents: WebContents, details: HandlerDetails): WindowOpenHandlerResponse => {
    const { url, disposition } = details
    const web = /^https?:/i.test(url)
    // ⌘-click and middle-click arrive as background-tab: open without switching.
    const activate = disposition !== 'background-tab'
    const win = windows.fromWebContents(contents.id)
    if (!win) {
      // A popup's own links open as tabs in the window in front.
      if (web && popups.owns(contents.id)) windows.focused()?.tabs.create(url, { activate })
      return { action: 'deny' }
    }
    if (contents === win.chrome) {
      if (web) win.tabs.create(url, { activate, afterId: win.tabs.activeId() ?? undefined })
      return { action: 'deny' }
    }
    const tab = win.tabs.byWebContents(contents)
    // A pack's page never opens windows or tabs of its own (docs/packs.md: atelier.open is the checked way).
    if (tab?.sandbox && /^atelier-pack:/i.test(contents.getURL())) return { action: 'deny' }
    if (disposition === 'new-window' && (web || url === 'about:blank' || url === '')) {
      if (tab) {
        const answer = consultPopupPolicies({ tab, url, disposition, userGesture: gestures.consume(contents.id), frameOrigin: originOf(details.referrer?.url || contents.getURL()) })
        if (answer === 'block') return { action: 'deny' }
      }
      return { action: 'allow', overrideBrowserWindowOptions: POPUP_OPTIONS, createWindow: (options) => createPopupWindow(options, contents, popupDeps) }
    }
    // A page's own window.open without popup features (and its target=_blank links) opens a tab
    // around the page Chromium made, as Chrome does: window.opener, the returned window and a
    // form's POST body survive (sign-in compatibility). Links keep their implicit noopener.
    // Tabs an agent opens from its out-of-sight tab open out of sight too.
    if (web && tab && !tab.sandbox && (disposition === 'foreground-tab' || disposition === 'background-tab')) {
      const placement = { activate: activate && !agentOutOfSight(win, tab), afterId: tab.id }
      return {
        action: 'allow',
        // Created as a tab's page is: the page preload, isolation and Atelier's dialogs.
        overrideBrowserWindowOptions: { webPreferences: win.tabs.pageWebPreferences() },
        // A tab stays when the tab that opened it closes.
        outlivesOpener: true,
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents
          if (!guest) return win.tabs.create('about:blank', placement).view.webContents
          return win.tabs.create(url, { ...placement, guest: { webContents: guest, webPreferences: options.webPreferences } }).view.webContents
        },
      }
    }
    if (web) win.tabs.create(url, { activate: activate && !(tab && agentOutOfSight(win, tab)), afterId: tab?.id })
    return { action: 'deny' }
  }

  const restoreSession = (): boolean => {
    try {
      if (smoke) return false
      const read = readSessionFile(sessionPath)
      if (!read.ok) {
        if (read.reason !== 'missing') {
          first.send({ type: 'session-notice', reason: read.reason })
          void toasts.show(first, { kind: 'info', text: mainT(read.reason === 'newer' ? 'core.session.newer' : 'core.session.corrupt') }).catch(() => undefined)
        }
        return false
      }
      const [main, ...rest] = read.session.windows
      if (!main || main.tabs.length === 0) return false
      restoreFirst(main)
      for (const saved of rest) {
        try {
          windows.open('normal', { saved, bounds: visibleBounds(saved.bounds) })
        } catch (err) {
          log.warn('session', 'A saved window could not be restored', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      first.window.focus()
      return true
    } finally {
      restoring = false
    }
  }

  const restoreFirst = (saved: SavedWindow): void => {
    restoreSaved(first.tabs, saved, first.id)
    first.chromeWindow.setSidebarOpen(saved.sidebarOpen)
    if (saved.name) first.chromeWindow.setName(saved.name)
    if (saved.displayMode === 'maximized') first.window.maximize()
    else if (saved.displayMode === 'fullscreen') first.window.setFullScreen(true)
  }

  // Smoke shots draw the overlay tiers over the window.
  if (smoke)
    setOverlayLayers((ui) => {
      const win = windows.all().find((w) => w.chrome === ui)
      if (!win || win.window.isDestroyed()) return []
      const { width, height } = win.window.getContentBounds()
      const layers: { wc: WebContents; bounds: Rect }[] = []
      const interactive = win.overlay.tierWebContents('interactive')
      const bounds = win.overlay.interactiveBounds()
      if (interactive && bounds) layers.push({ wc: interactive, bounds })
      const passive = win.overlay.tierWebContents('passive')
      if (passive && win.overlay.openSurfaces().some((s) => s.tier === 'passive')) layers.push({ wc: passive, bounds: { x: 0, y: 0, width, height } })
      return layers
    })

  started = { restoreSession, windowOpen, servicesOf, windows }
  return started
}

// ---- helpers ----

function zoomOf(win: WindowContext): number {
  try {
    return win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
  } catch {
    return 1
  }
}

/** The whole window, in chrome CSS px: sheets and notices place themselves inside it. */
function windowAnchor(win: WindowContext): { kind: 'window'; rect: Rect } {
  const { width, height } = win.window.getContentBounds()
  const zoom = zoomOf(win)
  return { kind: 'window', rect: { x: 0, y: 0, width: Math.round(width / zoom), height: Math.round(height / zoom) } }
}

/** An agent works in this tab while the person looks at another: what it opens stays out of sight too. */
function agentOutOfSight(win: WindowContext, tab: Tab): boolean {
  return tab.agentControlled && win.tabs.paneBounds(tab.id) === null
}

function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname
    return host ? host.replace(/^www\./, '').slice(0, 253) : null
  } catch {
    return null
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/** Saved bounds that no longer land on a display (one was unplugged) open at the default place. */
function visibleBounds(bounds: Bounds | undefined): Bounds | undefined {
  if (!bounds) return undefined
  const area = screen.getDisplayMatching(bounds).workArea
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
  const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
  return overlapX >= 100 && overlapY >= 50 ? bounds : undefined
}

export function quitDialog(busy: number): DialogSpec {
  return {
    title: mainT('core.quit.title'),
    description: mainT('core.quit.detail', { count: busy }),
    icon: busy > 0 ? 'warning' : 'info',
    checkbox: { label: mainT('core.quit.dontAsk'), checked: false },
    buttons: [
      { id: 'cancel', label: mainT('core.quit.cancel'), style: 'secondary', escape: true },
      { id: 'quit', label: mainT('core.quit.confirm'), style: 'primary', enter: true },
    ],
    dedupeKey: 'core:quit',
  }
}

export function closeWindowDialog(tabs: number): DialogSpec {
  return {
    title: mainT('core.closeWindow.title'),
    description: mainT('core.closeWindow.detail', { count: tabs }),
    icon: 'warning',
    checkbox: { label: mainT('core.quit.dontAsk'), checked: false },
    buttons: [
      { id: 'cancel', label: mainT('core.closeWindow.cancel'), style: 'secondary', escape: true },
      { id: 'close', label: mainT('core.closeWindow.confirm'), style: 'primary', enter: true },
    ],
    dedupeKey: 'core:close-window',
  }
}
