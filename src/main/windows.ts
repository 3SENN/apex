/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, app, screen, type WebContents } from 'electron'
import { UI, type Bounds, type InitialState } from '@shared/ipc'
import type { AppEvent, Services } from '@shared/services'
import { chatUrl } from '@shared/url'
import type { ClosedEntry, SavedWindow, SessionFile, WindowKind, WindowSummary } from '@shared/windows'
import { ClosedEntries, type ClosedRecord } from './closedEntries'
import type { WindowContext } from './features/types'
import { log } from './log'
import { popups } from './popups'
import { profileOfWindowId } from './profiles/windowProfiles'
import { chatIdOf, isRestorableUrl } from './tabState'
import type { Tab } from './tabs'
import { savedWindowExtras } from './sessionRestore'

// The window manager. Normal, private, popup and chat windows
// each get their own ChromeWindow, TabManager, PeekManager and OverlayHost
// (windowContext.ts builds them); UI channels and services route from sender
// to WindowContext. It also keeps the recently closed stack (SH-27) and
// serializes every normal window for session.json.

export const NOT_AVAILABLE = 'Not available yet'

/** New windows open this far from the focused one (SH-61). */
export const WINDOW_OFFSET_PX = 24

/** Events that belong to one window; everything else goes to every window. */
const WINDOW_SCOPED: ReadonlySet<AppEvent['type']> = new Set<AppEvent['type']>([
  'find',
  'peek',
  'window',
  'reload-page',
  'number-hints',
  'recent-tabs',
  'edge-reveal',
  'overlay-region',
  'window-veil',
  'focus-mode',
  'session-notice',
  'window-material',
  // Opened .ateliercompanion files show their review sheet in the first window only.
  'companion-import',
  'companion-import-error',
])

export function isWindowScopedEvent(event: AppEvent): boolean {
  return WINDOW_SCOPED.has(event.type)
}

/** Events the overlay renderers follow too (OV-04): the theme and settings tokens. */
function relaysToOverlay(event: AppEvent): boolean {
  return event.type === 'theme' || event.type === 'settings'
}

/** What the window manager keeps per window beyond its WindowContext. */
export interface WindowExtras {
  services: Services
  initialState(): InitialState
}

/** ProfileId is the profile the window opens in (SH-61). */
export type WindowFactory = (opts: { kind: Exclude<WindowKind, 'popup'>; url?: string; bounds?: Bounds; saved?: SavedWindow; profileId: string }) => { win: WindowContext } & WindowExtras

/** Offsets a window's bounds by 24 px, kept on the display it is on. */
export function offsetBounds(from: Bounds, area: Bounds, offset = WINDOW_OFFSET_PX): Bounds {
  let x = from.x + offset
  let y = from.y + offset
  // Wrap back to the top-left of the work area instead of walking off it.
  if (x + from.width > area.x + area.width) x = area.x
  if (y + from.height > area.y + area.height) y = area.y
  return { x, y, width: Math.min(from.width, area.width), height: Math.min(from.height, area.height) }
}

export class WindowManager {
  readonly #windows = new Map<number, WindowContext>()
  readonly #extras = new Map<number, WindowExtras>()
  /** Focus order, newest first, so a closed window hands focus to the last one used. */
  #order: number[] = []
  #factory: WindowFactory | null = null
  readonly closed = new ClosedEntries()
  #quitting = false
  readonly #listeners = new Set<() => void>()

  add(win: WindowContext, extras?: WindowExtras): void {
    this.#windows.set(win.id, win)
    if (extras) this.#extras.set(win.id, extras)
    // The tab's own reopen stack leaves out what the window's leaves out (CH-30).
    win.tabs.setEphemeral?.((url) => !this.#keeps(url))
    this.#order = [win.id, ...this.#order.filter((id) => id !== win.id)]
    win.window.on('focus', () => {
      this.#order = [win.id, ...this.#order.filter((id) => id !== win.id)]
      this.#changed()
    })
    win.window.on('page-title-updated', () => this.#changed())
    // Where each tab sat, so a closed one reopens at its position (it has left the list by 'closed').
    const positions = new Map<string, number>()
    const remember = (): void => {
      positions.clear()
      win.tabs.all().forEach((t, i) => positions.set(t.id, i))
    }
    remember()
    win.tabs.on('changed', () => {
      remember()
      this.#changed()
    })
    win.tabs.on('created', remember)
    // Closed tabs go on the reopen stack with their history (private windows add nothing).
    win.tabs.on('closed', (tab: Tab, info?: { moved?: boolean }) => {
      if (info?.moved || win.kind === 'private' || this.#closingWindows.has(win.id)) return
      const record = closedTabRecord(win, tab, positions.get(tab.id) ?? 0)
      if (record && this.#keeps(record.kind === 'chat' ? chatUrl(record.chatId) : record.kind === 'tab' ? record.url : '')) this.closed.push(record)
    })
    win.window.on('close', (event: Electron.Event) => {
      // ST-22: a guard may ask first (several unpinned tabs); it closes the window again once answered.
      if (!this.#quitting && !this.#allowClose.has(win.id) && this.#closeGuard?.(win)) {
        event.preventDefault()
        return
      }
      this.#closingWindows.add(win.id)
      if (this.#quitting || win.kind === 'private' || win.window.isDestroyed()) return
      const saved = this.serializeWindow(win)
      if (win.kind === 'chat') {
        const chatId = chatIdOfWindow(win)
        if (chatId && this.#keeps(chatUrl(chatId))) this.closed.push({ kind: 'chat', chatId, title: win.window.getTitle(), closedAt: Date.now() })
      } else if (saved && this.#windows.size > 1) {
        // The last window closing quits the app; its tabs come back through session restore instead.
        this.closed.push({ kind: 'window', title: win.window.getTitle(), tabCount: saved.tabs.length, closedAt: Date.now(), saved })
      }
    })
    win.window.once('closed', () => {
      this.#windows.delete(win.id)
      this.#extras.delete(win.id)
      this.#closingWindows.delete(win.id)
      this.#order = this.#order.filter((id) => id !== win.id)
      // A closed window doesn't destroy its views' pages.
      for (const tab of win.tabs.all()) {
        const wc = tab.view.webContents as Electron.WebContents | undefined
        if (wc && !wc.isDestroyed()) wc.close()
      }
      this.#changed()
    })
    this.#changed()
  }

  readonly #closingWindows = new Set<number>()
  readonly #allowClose = new Set<number>()
  #closeGuard: ((win: WindowContext) => boolean) | null = null

  /** ST-22: returns true to hold a window's close (the guard asks, then calls closeNow). */
  setCloseGuard(fn: ((win: WindowContext) => boolean) | null): void {
    this.#closeGuard = fn
  }

  /** Closes a window without asking again. */
  closeNow(id: number): void {
    const win = this.#windows.get(id)
    if (!win || win.window.isDestroyed()) return
    this.#allowClose.add(id)
    win.window.close()
    // A close another handler cancelled asks again next time.
    setImmediate(() => this.#allowClose.delete(id))
  }

  /** index.ts installs the factory once the app-wide parts exist. */
  setFactory(factory: WindowFactory): void {
    this.#factory = factory
  }

  #ephemeral: ((url: string) => boolean) | null = null

  /** CH-30: addresses that never go on a reopen stack (⇧⌘T, History) or into a saved window: a private chat's page. */
  setEphemeral(fn: ((url: string) => boolean) | null): void {
    this.#ephemeral = fn
  }

  #keeps(url: string): boolean {
    return this.#ephemeral?.(url) !== true
  }

  /** Set on before-quit: closing windows then aren't "recently closed". */
  setQuitting(quitting: boolean): void {
    this.#quitting = quitting
  }

  get quitting(): boolean {
    return this.#quitting
  }

  get(id: number): WindowContext | undefined {
    return this.#windows.get(id)
  }

  all(): WindowContext[] {
    return [...this.#windows.values()]
  }

  extras(id: number): WindowExtras | undefined {
    return this.#extras.get(id)
  }

  /** The window whose chrome, overlay views or tabs sent an IPC message. */
  fromWebContents(webContentsId: number): WindowContext | null {
    for (const win of this.#windows.values()) {
      if (!win.chrome.isDestroyed() && win.chrome.id === webContentsId) return win
      if (win.overlay.ownsWebContents(webContentsId)) return win
      if (win.tabs.all().some((t) => { const wc = t.view.webContents as Electron.WebContents | undefined; return !!wc && !wc.isDestroyed() && wc.id === webContentsId })) return win
    }
    return null
  }

  /** The window whose chrome (main frame) sent an IPC message, or one of its overlay renderers. */
  fromUiSender(sender: WebContents, senderFrame: unknown): WindowContext | null {
    for (const win of this.#windows.values()) {
      if (win.chrome.isDestroyed()) continue
      if (win.chrome === sender && senderFrame !== null && senderFrame === win.chrome.mainFrame) return win
      if (win.overlay.ownsWebContents(sender.id) && senderFrame === sender.mainFrame) return win
    }
    return null
  }

  focused(): WindowContext | null {
    for (const win of this.#windows.values()) if (!win.window.isDestroyed() && win.window.isFocused()) return win
    // Nothing focused (another app is in front): the most recently used window.
    for (const id of this.#order) {
      const win = this.#windows.get(id)
      if (win && !win.window.isDestroyed()) return win
    }
    return this.#windows.values().next().value ?? null
  }

  list(): WindowSummary[] {
    const focused = BrowserWindow.getFocusedWindow()
    const rows: WindowSummary[] = this.all().map((w) => ({
      id: w.id,
      kind: w.kind,
      title: w.window.isDestroyed() ? '' : w.window.getTitle(),
      tabCount: w.tabs.all().length,
      focused: !w.window.isDestroyed() && w.window === focused,
    }))
    for (const p of popups.all()) {
      if (p.window.isDestroyed()) continue
      rows.push({ id: p.window.id, kind: 'popup', title: p.window.getTitle(), tabCount: 0, focused: p.window.isFocused() })
    }
    return rows
  }

  /**
   * A new normal or private window, 24 px from the focused one; resolves to
   * its id. It opens in the given profile, or the focused window's
   * (⌘N keeps the profile you're in, SH-61).
   */
  open(kind: Exclude<WindowKind, 'popup' | 'chat'>, options: { url?: string; saved?: SavedWindow; bounds?: Bounds; profileId?: string } = {}): number {
    return this.#create({ kind, ...options })
  }

  /** Pops a chat out into its own chat window (CH-03); an open one comes forward instead. */
  openChat(chatId: string): number {
    const existing = this.all().find((w) => w.kind === 'chat' && chatIdOfWindow(w) === chatId)
    if (existing) {
      existing.window.focus()
      return existing.id
    }
    const id = this.#create({ kind: 'chat', url: chatUrl(chatId) })
    this.closed.forgetChat(chatId)
    return id
  }

  #create(opts: { kind: Exclude<WindowKind, 'popup'>; url?: string; saved?: SavedWindow; bounds?: Bounds; profileId?: string }): number {
    if (!this.#factory) throw new Error(NOT_AVAILABLE)
    const bounds = opts.bounds ?? opts.saved?.bounds ?? this.#nextBounds()
    const profileId = opts.profileId ?? opts.saved?.profileId ?? profileOfWindowId(this.focused()?.id)
    const { win, ...extras } = this.#factory({ ...opts, bounds, profileId })
    this.add(win, extras)
    return win.id
  }

  #nextBounds(): Bounds | undefined {
    const from = this.focused()
    if (!from || from.window.isDestroyed()) return undefined
    const current = from.window.getNormalBounds()
    const area = screen.getDisplayMatching(current).workArea
    return offsetBounds(current, area)
  }

  focus(id: number): void {
    const win = this.#windows.get(id)
    if (win) {
      if (win.window.isMinimized()) win.window.restore()
      win.window.focus()
      return
    }
    const popup = popups.all().find((p) => p.window.id === id)
    if (!popup) throw new Error('That window is closed.')
    popup.window.focus()
  }

  recentlyClosed(): ClosedEntry[] {
    return this.closed.list()
  }

  /** ⇧⌘T or a History menu entry: reopens into the focused window; false (and a beep) when nothing is left. */
  reopen(index = 0): boolean {
    const record = this.closed.take(index)
    // Nothing to reopen: the command reports false and NS-04's failure cue plays.
    if (!record) return false
    const target = this.focused()
    if (record.kind === 'window') {
      this.open('normal', { saved: record.saved })
      return true
    }
    if (!target) return false
    if (record.kind === 'chat') {
      target.tabs.openInternal(chatUrl(record.chatId), { newTab: true })
      return true
    }
    target.tabs.create(record.url, {
      index: record.index,
      pinned: record.pinned,
      ...(record.groupId ? { groupId: record.groupId } : {}),
      history: { entries: record.entries.length ? record.entries : [{ url: record.url, title: record.title }], index: record.entryIndex },
    })
    target.window.focus()
    return true
  }

  /** One window's SavedWindow for session.json (normal windows only). */
  serializeWindow(win: WindowContext): SavedWindow | null {
    if (win.kind === 'private' || win.kind === 'popup' || win.window.isDestroyed()) return null
    let tabs
    try {
      tabs = win.tabs.serialize()
    } catch {
      // Without serialize: addresses without history.
      tabs = win.tabs
        .all()
        .map((t) => win.tabs.info(t))
        .filter((i) => isRestorableUrl(i.url))
        .map((i) => ({ url: i.url, title: i.title, pinned: i.pinned, groupId: null, entries: [{ url: i.url, title: i.title }], index: 0 }))
    }
    // CH-30: a private chat's tab can't come back (nothing of the chat was saved), so neither a reopen nor a restore brings it.
    tabs = tabs.filter((t) => this.#keeps(t.url))
    const kept = win.tabs.all().filter((t) => isRestorableUrl(win.tabs.info(t).url) && this.#keeps(win.tabs.info(t).url))
    const ids = kept.map((t) => t.id)
    const activeIndex = Math.max(0, ids.indexOf(win.tabs.activeId() ?? ''))
    const split = win.tabs.split()
    const primary = split ? ids.indexOf(split.primaryId) : -1
    const secondary = split ? ids.indexOf(split.secondaryId) : -1
    const ratio = split && 'ratio' in split && typeof (split as { ratio?: unknown }).ratio === 'number' ? (split as unknown as { ratio: number }).ratio : 0.5
    const snapshot = win.tabs.snapshot() as { groups?: SavedWindow['groups'] }
    const window = win.window
    const displayMode: SavedWindow['displayMode'] = window.isFullScreen() ? 'fullscreen' : window.isMaximized() ? 'maximized' : 'normal'
    const state = win.chromeWindow.state()
    return {
      bounds: window.getNormalBounds(),
      displayMode,
      sidebarOpen: state.sidebarOpen,
      name: state.name,
      tabs,
      activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)),
      split: primary >= 0 && secondary >= 0 ? { primary, secondary, ratio } : null,
      groups: (snapshot.groups ?? []).map((g) => ({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed })),
      ...savedWindowExtras(win.id, ids),
      // Restore and reopen put the window back in its own profile.
      profileId: profileOfWindowId(win.id),
    }
  }

  /** Every normal window, in focus order (the first restores as the main window). */
  serialize(): SessionFile {
    const ordered = [...this.#order.map((id) => this.#windows.get(id)).filter((w): w is WindowContext => !!w)].reverse()
    const windows = ordered.filter((w) => w.kind === 'normal').map((w) => this.serializeWindow(w)).filter((w): w is SavedWindow => w !== null && w.tabs.length > 0)
    return { version: 1, windows }
  }

  /** Sends an event to every window's chrome; theme and settings reach the overlay renderers too. */
  broadcast(event: AppEvent): void {
    for (const win of this.#windows.values()) {
      if (win.chrome.isDestroyed()) continue
      win.chrome.send(UI.appEvent, event)
      if (relaysToOverlay(event)) win.overlay.relay(event)
    }
  }

  /** Window lists in menus follow this. */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #changed(): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn()
      } catch (err) {
        log.warn('windows', 'A window listener failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

function chatIdOfWindow(win: WindowContext): string | null {
  for (const tab of win.tabs.all()) {
    const chatId = chatIdOf(tab.internalUrl)
    if (chatId) return chatId
  }
  return null
}

function closedTabRecord(win: WindowContext, tab: Tab, index: number): ClosedRecord | null {
  const info = win.tabs.info(tab)
  const chatId = chatIdOf(tab.internalUrl)
  if (chatId) return { kind: 'chat', chatId, title: info.title, closedAt: Date.now() }
  if (!isRestorableUrl(info.url)) return null
  let entries: { url: string; title: string }[] = [{ url: info.url, title: info.title }]
  let entryIndex = 0
  const wc = tab.view.webContents
  if (!tab.internalUrl && !wc.isDestroyed()) {
    const all = wc.navigationHistory.getAllEntries().map((e) => ({ url: e.url, title: e.title }))
    const kept = all.filter((e) => isRestorableUrl(e.url)).slice(-25)
    if (kept.length > 0) {
      entries = kept
      entryIndex = Math.max(0, kept.findIndex((e) => e.url === info.url))
    }
  }
  return { kind: 'tab', title: info.title, url: info.url, closedAt: Date.now(), index, pinned: tab.pinned, entries, entryIndex, groupId: (info as { groupId?: string | null }).groupId ?? null }
}

/** Quit when the last window closes, except on macOS where apps stay in the Dock. */
export function lastWindowClosed(): void {
  if (process.platform !== 'darwin') app.quit()
}

// SH-26
/** Repeats this close together count as one press. */
export const CLOSE_COALESCE_MS = 300

export type CloseTarget = 'popup' | 'other-window' | 'peek' | 'rail' | 'selection' | 'tab' | 'none'

/** What ⌘W closes: a focused popup, then an open peek, then the selection, then the active tab. */
export function closeTarget(s: { popupFocused: boolean; otherWindowFocused: boolean; windowFocused: boolean; peekOpen: boolean; rail: boolean; selection: number; activeTab: boolean }): CloseTarget {
  if (s.popupFocused) return 'popup'
  // Another window of Atelier's own in front (developer tools, a floating card) closes instead.
  if (s.otherWindowFocused) return 'other-window'
  if (!s.windowFocused) return 'none'
  if (s.peekOpen) return 'peek'
  if (s.rail) return 'rail'
  if (s.selection > 1) return 'selection'
  return s.activeTab ? 'tab' : 'none'
}

/** One press never closes more than one target: repeats within CLOSE_COALESCE_MS are dropped. */
export class CloseCoalescer {
  #last = Number.NEGATIVE_INFINITY
  readonly #windowMs: number

  constructor(windowMs = CLOSE_COALESCE_MS) {
    this.#windowMs = windowMs
  }

  accept(now: number): boolean {
    if (now - this.#last < this.#windowMs) return false
    this.#last = now
    return true
  }
}

/** ST-22: closing a window asks first when it holds several unpinned tabs. */
export function needsCloseConfirm(s: { enabled: boolean; kind: WindowKind; unpinnedTabs: number }): boolean {
  return s.enabled && (s.kind === 'normal' || s.kind === 'private') && s.unpinnedTabs > 1
}
