/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Menu, WebContentsView, clipboard, shell, type BrowserWindow, type Session, type WebContents } from 'electron'
import { PAGE, type AgentOverlay, type Bounds, type OrderEntry, type RailState, type TabInfo, type TabsSnapshot } from '@shared/ipc'
import type { FindResult, LayoutBounds, NavigationEntry, SplitState } from '@shared/services'
import { chatUrl, internalTitle, isBlankUrl, isDestinationUrl, isInternalUrl, parseInternalUrl, resolveInternalUrl, type InternalNames } from '@shared/url'
import type { HistoryStore } from './history'
import { detachInput } from './input'
import type { PageBridge } from './pageBridge'
import { ClosedTabStack, chatIdOf, currentIndex, effectiveOrder, isRestorableUrl, nthEntry, stepEntry, type PinnedTabsStore } from './tabState'
import type { PageLeft, PageVisit } from '@shared/timeline'
import { nextTabId } from './tabRegistry'
import type { SavedGroup, SavedTab } from '@shared/windows'
import { showPageMenu } from './pageMenu'
import { SPLIT_EVEN, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN, type TabGroup, type TabMedia } from '@shared/tabs'
import { TabGroupStore, gatherGroup, joinBlock, moveOne, skipCollapsed } from './tabGroups'
import { mainT } from './i18n/mainT'
import { pagePasskeyArguments } from './signInCompat'

export interface Tab {
  id: string
  view: WebContentsView
  favicon: string | null
  agentControlled: boolean
  /** The chat whose agent controls the tab, while one does. */
  agentChatId: string | null
  needsInput: boolean
  pinned: boolean
  lastActiveAt: number
  /** Set while the tab shows an apex:// page drawn by the chrome. */
  internalUrl: string | null
  /** The last web address asked for, until the page commits one. */
  requestedUrl: string
  /** An artifact tab's locked-down session; its views never get the page preload. */
  sandbox?: Session
}

export interface CreateTabOptions {
  activate?: boolean
  /** An exact index in the manual order (reopening a closed tab). */
  index?: number
  /** Right after this tab. */
  afterId?: string
  /** 'top' is just below the pinned tabs. Without any placement the tab goes to the end. */
  position?: 'top' | 'end'
  pinned?: boolean
  /** Join this group (new tab in group). */
  groupId?: string
  /** Restore this history when the tab is first shown, instead of loading `url` (lazy session restore). */
  history?: SavedHistory
  // Artifact tabs render in their own locked-down session, without the page preload
  sandbox?: { session: Session }
  // ── sign-in compatibility create option ── (window.open without popup features: the tab adopts the page Chromium made, so window.opener and the returned window stay as in Chrome)
  guest?: { webContents: WebContents; webPreferences?: Electron.WebPreferences }
}

/** A tab's back and forward list, kept while its page is asleep or not restored yet. */
export interface SavedHistory {
  entries: { url: string; title: string }[]
  index: number
  favicon?: string | null
}

/** How many history entries a tab keeps in session.json and while asleep. */
const SAVED_HISTORY_LIMIT = 50

interface TabManagerOptions {
  window: BrowserWindow
  session: Session
  preloadPath: string
  history: HistoryStore
  bridge: PageBridge
  onFindResult?: (result: FindResult) => void
  onPeek?: (url: string) => void
  /** Chat titles and companion names for apex:// tab titles and breadcrumbs. */
  names?: InternalNames
  /** The in-page agent overlay's look and text for a controlled tab. */
  agentOverlay?: (tab: Tab) => Omit<AgentOverlay, 'active'>
  /** Where pinned tabs are saved; without it pinning lasts for the session. */
  pinned?: PinnedTabsStore
  /** The window this manager belongs to (TabInfo.windowId); 1 when unset (the first window). */
  windowId?: number
}

// 'page-visited' and 'page-left' feed the visits log, activity memory and search
export interface TabManagerEvents {
  changed: []
  'page-fullscreen': [active: boolean]
  /** `moved` is set when the tab arrives from another window (adopt). */
  created: [tab: Tab, info?: { moved: boolean }]
  /** `moved` is set when the tab leaves for another window (release): its page lives on. */
  closed: [tab: Tab, info?: { moved: boolean }]
  /** The tab got a fresh page view (it slept and woke); listeners on the old webContents must re-attach. */
  'view-replaced': [tab: Tab, old: WebContents]
  activated: [tab: Tab]
  moved: [tab: Tab, index: number]
  navigated: [tab: Tab, nav: { url: string; mainFrame: boolean; inPage: boolean }]
  'zoom-changed': [tab: Tab, percent: number]
}

// Merged into TabManagerEvents
export interface TabManagerEvents {
  'page-visited': [visit: PageVisit]
  'page-left': [left: PageLeft]
  /** A visited page's title arrived (usually just after 'page-visited'). */
  'page-titled': [titled: { tabId: string; url: string; title: string }]
}

/** Extra TabInfo fields a feature computes for a tab (groups, sleep, capture, errors). */
export type TabDecorator = (tab: Tab) => Partial<TabInfo>

/** The TabInfo fields beyond the basics (windowId to unresponsive). */
type TabStateFields = Omit<TabInfo, 'id' | 'title' | 'url' | 'favicon' | 'loading' | 'canGoBack' | 'canGoForward' | 'agentControlled' | 'agentChatId' | 'needsInput' | 'pinned' | 'audible' | 'muted' | 'lastActiveAt' | 'crumbs'>

// Only mail links skip the ask; other app links reach the sites feature's 'openExternal' prompt.
const EXTERNAL_SCHEMES = new Set(['mailto:'])
const NO_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 }
const SNAPSHOT_WIDTH = 400
const HISTORY_LIMIT = 25

/**
 * Owns every tab's WebContentsView. Emits 'changed' whenever the visible tab
 * state changes, and 'page-fullscreen' when a page enters or leaves HTML
 * full screen.
 */
export class TabManager extends EventEmitter<TabManagerEvents> {
  readonly #options: TabManagerOptions
  /** Manual order: pinned tabs first. */
  readonly #tabs: Tab[] = []
  #activeId: string | null = null
  #recent: string[] = []
  #layout: LayoutBounds = { primary: NO_BOUNDS, secondary: null, peek: null }
  readonly #hiddenReasons = new Set<string>()
  #split: SplitState | null = null
  #order: OrderEntry[] | null = null
  /** The destination on the window-level surface (DS-99), or null while a tab shows. */
  #rail: string | null = null
  readonly #closed = new ClosedTabStack()
  /** The last Clear, for its Undo (the toast's). */
  #lastClear: { id: string; tabs: Array<{ id: string; index: number; active: boolean; saved: SavedTab | null }>; placeholder: string | null; mark: number } | null = null
  #fullScreenId: string | null = null
  #fullScreenWasNative = false
  /** Set while restoring pinned tabs, so the file isn't rewritten one tab at a time. */
  #restoring = false
  readonly #decorators: TabDecorator[] = []
  #selection: string[] = []
  // Tabs whose pane the chrome draws over, such as error pages
  readonly #covers: ((tab: Tab) => boolean)[] = []
  readonly #groups = new TabGroupStore()
  #splitRatio = SPLIT_EVEN
  /** Tabs whose page is asleep or not restored yet: what to bring back on first show. */
  readonly #asleep = new Map<string, SavedHistory & { url: string; title: string }>()
  /** Woken tabs that have not reported a title yet (skeleton rows, SS-01). */
  readonly #restoringIds = new Set<string>()
  readonly #unwire = new Map<string, () => void>()
  #media: (() => TabMedia | null) | null = null

  constructor(options: TabManagerOptions) {
    super()
    // Each window's features (sidebar, dialogs, session, tooltips, the feature modules) all follow its tabs.
    this.setMaxListeners(50)
    this.#options = options
    // The full-screen page follows the window's size.
    options.window.on('resize', () => {
      if (this.#fullScreenId) this.#applyLayout()
    })
  }

  create(url = 'about:blank', options: CreateTabOptions = {}): Tab {
    const { activate = true } = options
    const view = options.guest ? this.#adoptView(options.guest) : this.#makeView(options.sandbox?.session) // Artifact tabs
    const internal = isInternalUrl(url) ? (resolveInternalUrl(url) ?? url) : null
    const tab: Tab = {
      // Global ids ('t<n>') survive moving a tab to another window.
      id: nextTabId(),
      view,
      favicon: null,
      agentControlled: false,
      agentChatId: null,
      needsInput: false,
      pinned: options.pinned ?? false,
      lastActiveAt: Date.now(),
      internalUrl: internal,
      requestedUrl: internal ? '' : url,
      ...(options.sandbox ? { sandbox: options.sandbox.session } : {}),
    }
    this.#tabs.splice(this.#insertIndex(tab, options), 0, tab)
    // A lazily restored tab keeps its history until it is first shown.
    const history = options.history && !internal ? trimHistory(options.history) : null
    if (history) this.#asleep.set(tab.id, { ...history, url: history.entries[history.index]?.url ?? url, title: history.entries[history.index]?.title ?? '' })
    if (options.groupId && this.#groups.get(options.groupId) && !tab.pinned) {
      this.#groups.add(options.groupId, [tab.id])
      this.#regroup(options.groupId)
    }
    this.#wire(tab)
    view.setVisible(false)
    this.#options.window.contentView.addChildView(view)
    if (activate || this.#activeId === null) this.activate(tab.id)
    // A fresh WebContents is already an empty document. Loading about:blank
    // explicitly would race with a navigation issued right after creation.
    // An adopted page is loaded by Electron once createWindow returns.
    if (!isBlankUrl(url) && !internal && !history && !options.guest) {
      void view.webContents.loadURL(url).catch(() => {
        // Load failures surface through did-fail-load; nothing to do here.
      })
    }
    if (tab.pinned) this.#savePinned()
    this.emit('created', tab)
    this.#changed()
    return tab
  }

  /** Brings back the pinned tabs saved last session, without activating them. */
  restorePinned(): void {
    this.#restoring = true
    try {
      for (const saved of this.#options.pinned?.load() ?? []) this.create(saved.url, { activate: false, pinned: true })
    } finally {
      this.#restoring = false
    }
  }

  /** Opens a URL in a tab: apex:// pages are drawn by the chrome, the rest load. */
  navigate(id: string, url: string): void {
    const tab = this.get(id)
    // Going somewhere new replaces a page that was asleep.
    this.#asleep.delete(id)
    // Going somewhere in the active tab brings that tab back from behind a destination.
    if (id === this.#activeId) this.#rail = null
    if (isInternalUrl(url)) {
      const target = resolveInternalUrl(url)
      if (!target) throw new Error(`Unknown ${BRAND_NAME} page ${url}.`)
      tab.internalUrl = target
      this.#applyLayout()
      if (tab.pinned) this.#savePinned()
      this.#changed()
      return
    }
    tab.internalUrl = null
    tab.requestedUrl = url
    this.#applyLayout()
    this.#changed()
    void tab.view.webContents.loadURL(url).catch(() => undefined)
  }

  /** Leaves an Apex page so the tab's web content shows again. */
  leaveInternal(id: string): void {
    const tab = this.get(id)
    if (!tab.internalUrl) return
    tab.internalUrl = null
    this.#applyLayout()
    this.#changed()
  }

  /**
   * Opens an Apex page, reusing the tab that already shows it (for chats,
   * the tab showing that same chat), unless `newTab` is set. Destinations
   * open on the window-level surface instead (DS-99): the active tab stays
   * as it is, hidden, and no tab is created; `newTab` keeps the old way.
   */
  openInternal(url: string, { newTab = false, background = false }: { newTab?: boolean; background?: boolean } = {}): void {
    const target = resolveInternalUrl(url)
    const route = target ? parseInternalUrl(target) : null
    if (!target || !route) throw new Error(`Unknown ${BRAND_NAME} page ${url}.`)
    if (!newTab && !background && isDestinationUrl(target)) {
      this.showRail(target)
      return
    }
    const existing = newTab
      ? undefined
      : this.#tabs.find((t) => {
          const other = t.internalUrl ? parseInternalUrl(t.internalUrl) : null
          // Each file has its own viewer tab; only the same file's tab is reused.
          return other?.page === route.page && (route.page !== 'chat' || other.id === route.id) && (route.page !== 'file' || t.internalUrl === target)
        })
    if (existing) {
      // ⌘, on an open settings tab keeps the page it shows; destinations go back to their root.
      const keepPage = route.page === 'settings' && !parseInternalUrl(url)?.section
      if (!keepPage) existing.internalUrl = target
      if (!background) this.activate(existing.id)
      this.#applyLayout()
      this.#changed()
    } else {
      this.create(target, { activate: !background, afterId: this.#activeId ?? undefined })
    }
  }

  /** Shows a destination on the window-level surface, over the active tab. */
  showRail(url: string): void {
    if (this.#fullScreenId) this.#exitPageFullScreen()
    this.#rail = url
    this.#applyLayout()
    this.#changed()
  }

  /** Leaves the destination surface; the active tab shows again as it was. */
  leaveRail(): void {
    if (this.#rail === null) return
    this.#rail = null
    this.#applyLayout()
    this.#changed()
  }

  rail(): string | null {
    return this.#rail
  }

  back(id: string): void {
    // Back from a destination returns to the tab behind it.
    if (this.#rail !== null && id === this.#activeId) return this.leaveRail()
    const tab = this.get(id)
    const wc = tab.view.webContents
    if (tab.internalUrl && !isBlankUrl(wc.getURL())) {
      tab.internalUrl = null
      this.#applyLayout()
      this.#changed()
    } else if (wc.navigationHistory.canGoBack()) {
      tab.internalUrl = null
      wc.navigationHistory.goBack()
    }
  }

  /** ⌘R and the reload button. apex:// pages are drawn by the chrome, so the caller remounts those instead. */
  reload(id: string, bypassCache = false): void {
    const wc = this.get(id).view.webContents
    if (bypassCache) wc.reloadIgnoringCache()
    else wc.reload()
  }

  /**
   * CH-30: a guard may hold a tab's close to ask first (it returns true); it
   * calls `proceed` once the person agrees, which closes the tab after all.
   */
  setCloseGuard(guard: ((tab: Tab, proceed: () => void) => boolean) | null): void {
    this.#closeGuard = guard
  }

  #closeGuard: ((tab: Tab, proceed: () => void) => boolean) | null = null

  /** CH-30: addresses ⇧⌘T never brings back (a private chat's page); WindowManager sets it. */
  setEphemeral(fn: ((url: string) => boolean) | null): void {
    this.#closed.setSkip(fn)
  }

  close(id: string, { keepOne = true, asked = false }: { keepOne?: boolean; asked?: boolean } = {}): void {
    const index = this.#tabs.findIndex((t) => t.id === id)
    if (index === -1) throw new Error(`No tab with id ${id}.`)
    if (!keepOne && this.#tabs.length === 1) throw new Error('Cannot close the last tab.')
    const held = this.#tabs[index]
    if (!asked && held && this.#closeGuard?.(held, () => this.find(id) && this.close(id, { keepOne, asked: true }))) return
    const [tab] = this.#tabs.splice(index, 1)
    if (!tab) return
    this.#closed.push({ url: this.#urlOf(tab), title: this.info(tab).title, pinned: tab.pinned, index })
    if (this.#split && (this.#split.primaryId === id || this.#split.secondaryId === id)) this.#split = null
    if (this.#fullScreenId === id) this.#exitPageFullScreen()
    this.#recent = this.#recent.filter((r) => r !== id)
    this.#options.bridge.rejectAll(tab.view.webContents.id, 'The tab was closed.')
    this.#options.window.contentView.removeChildView(tab.view)
    this.#selection = this.#selection.filter((s) => s !== id)
    this.#forget(tab)
    this.emit('closed', tab)
    this.#pageLeft(tab)
    tab.view.webContents.close()
    if (tab.pinned) this.#savePinned()
    if (this.#activeId === id) {
      this.#activeId = null
      const next = this.find(this.#recent[0] ?? '') ?? this.#tabs[Math.min(index, this.#tabs.length - 1)]
      if (next) this.activate(next.id)
    }
    if (this.#tabs.length === 0) this.create()
    this.#applyLayout()
    this.#changed()
  }

  /** Bulk close (close others, below, all): pinned tabs are never touched. */
  closeMany(ids: readonly string[]): number {
    let closed = 0
    for (const id of ids) {
      const tab = this.find(id)
      if (!tab || tab.pinned) continue
      this.close(id)
      closed++
    }
    return closed
  }

  /**
   * The sidebar's Clear and Close All Tabs: closes every unpinned tab and
   * keeps what Undo needs to put them back. Null when there was none.
   */
  clearUnpinned(): { id: string; closed: number } | null {
    const targets = this.#tabs.map((tab, index) => ({ tab, index })).filter(({ tab }) => !tab.pinned)
    if (targets.length === 0) return null
    const mark = this.#closed.mark()
    const batch = targets.map(({ tab, index }) => ({ id: tab.id, index, active: tab.id === this.#activeId, saved: this.#saved(tab) }))
    this.closeMany(batch.map((b) => b.id))
    // A tab that asks before it closes stays until you answer; it isn't counted, and Undo leaves it alone.
    const gone = batch.filter((b) => !this.find(b.id))
    // Closing the last tab opens a new one; Undo closes it again if it is still empty.
    const left = this.#tabs.length === 1 ? this.#tabs[0] : undefined
    const placeholder = left && !left.pinned && !batch.some((b) => b.id === left.id) ? left.id : null
    this.#lastClear = { id: randomUUID(), tabs: gone, placeholder, mark }
    return { id: this.#lastClear.id, closed: gone.length }
  }

  /** Undo for clearUnpinned: the tabs come back where they were, asleep with their history, in their group if it is still there. */
  undoClear(id: string): number {
    const clear = this.#lastClear
    if (!clear || clear.id !== id) return 0
    this.#lastClear = null
    let restored = 0
    let toActivate: string | null = null
    for (const b of [...clear.tabs].sort((x, y) => x.index - y.index)) {
      if (!b.saved) continue
      const { url, entries, index, groupId } = b.saved
      const tab = this.create(url, { index: b.index, activate: false, history: { entries, index }, ...(groupId && this.#groups.get(groupId) ? { groupId } : {}) })
      if (b.active) toActivate = tab.id
      restored++
    }
    if (restored === 0) return 0
    this.#closed.dropSince(clear.mark)
    const placeholder = clear.placeholder ? this.find(clear.placeholder) : undefined
    if (placeholder && isBlankUrl(this.#urlOf(placeholder))) this.close(placeholder.id)
    // The tab you were on comes forward again; when that was a pinned tab, it stays.
    if (toActivate) this.activate(toActivate)
    this.#changed()
    return restored
  }

  /** ⇧⌘T: reopens the most recently closed tab where it was. */
  reopenClosed(): boolean {
    const closed = this.#closed.pop()
    if (!closed) return false
    this.create(closed.url, { index: closed.index, pinned: closed.pinned })
    return true
  }

  duplicate(id: string): Tab {
    const tab = this.get(id)
    return this.create(this.#urlOf(tab), { afterId: id })
  }

  activate(id: string): void {
    const tab = this.get(id)
    // Choosing any tab (or a chat's tab) leaves the destination surface.
    this.#rail = null
    // Activating a tab outside the split pair leaves split view.
    if (this.#split && tab.id !== this.#split.primaryId && tab.id !== this.#split.secondaryId) this.#split = null
    // Another tab can't come forward while a page fills the window.
    if (this.#fullScreenId && this.#fullScreenId !== tab.id) this.#exitPageFullScreen()
    this.#activeId = tab.id
    tab.lastActiveAt = Date.now()
    this.#recent = [tab.id, ...this.#recent.filter((r) => r !== tab.id)]
    // A normal activation clears the selection, opens a collapsed group and wakes a sleeping page.
    this.#selection = []
    const groupId = this.#groups.groupOf(tab.id)
    if (groupId && this.#groups.get(groupId)?.collapsed) this.#groups.update(groupId, { collapsed: false })
    this.#wake(tab)
    this.#applyLayout()
    this.emit('activated', tab)
    this.#changed()
  }

  // ---- order, pinning, sound ----

  /** The chrome's visible order (sidebar or strip), used by the tab shortcuts. */
  setOrder(entries: OrderEntry[]): void {
    this.#order = entries
  }

  /**
   * A reloaded chrome starts with no overlay holds and hasn't reported its
   * order yet; what the old renderer left behind would keep pages hidden.
   */
  resetChromeState(): void {
    this.#order = null
    this.setHidden('overlay', false)
  }

  /** The order the shortcuts follow right now. */
  visibleOrder(): OrderEntry[] {
    const order = effectiveOrder(this.#order, this.#tabs.map((t) => ({ id: t.id, chatId: chatIdOf(t.internalUrl) })))
    // Tabs inside collapsed groups are skipped (SH-20, SH-23).
    return skipCollapsed(order, (id) => this.#groups.isHidden(id))
  }

  /** ⌘1–8 (n = 0–7) and ⌘9 ('last'). */
  selectNth(n: number | 'last'): void {
    const entry = nthEntry(this.visibleOrder(), n)
    if (entry) this.#select(entry)
  }

  /** Next (1) or previous (-1) entry in visible order, wrapping. */
  step(delta: number): void {
    const order = this.visibleOrder()
    const active = this.active()
    const entry = stepEntry(order, currentIndex(order, active && { id: active.id, chatId: chatIdOf(active.internalUrl) }), delta)
    if (entry) this.#select(entry)
  }

  #select(entry: OrderEntry): void {
    if (entry.kind === 'tab') this.activate(entry.id)
    else this.openInternal(chatUrl(entry.id))
  }

  /** Moves a tab within its block (pinned or not) of the manual order. */
  move(id: string, index: number): void {
    const from = this.#tabs.findIndex((t) => t.id === id)
    const [tab] = from === -1 ? [] : this.#tabs.splice(from, 1)
    if (!tab) throw new Error(`No tab with id ${id}.`)
    const pinnedCount = this.#pinnedCount()
    const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, this.#tabs.length]
    const to = Math.min(max, Math.max(min, Math.round(index)))
    this.#tabs.splice(to, 0, tab)
    this.#placeInGroups(tab, to)
    if (tab.pinned) this.#savePinned()
    this.emit('moved', tab, this.#tabs.indexOf(tab))
    this.#changed()
  }

  /** Pinning moves the tab to the end of the pinned block; unpinning to the top of the list below it. */
  setPinned(id: string, pinned: boolean): void {
    const tab = this.get(id)
    if (tab.pinned === pinned) return
    this.#tabs.splice(this.#tabs.indexOf(tab), 1)
    tab.pinned = pinned
    // Pinned tiles sit outside groups.
    if (pinned) this.#groups.remove([id])
    this.#tabs.splice(this.#pinnedCount(), 0, tab)
    this.#savePinned()
    this.#changed()
  }

  setMuted(id: string, muted: boolean): void {
    this.get(id).view.webContents.setAudioMuted(muted)
    this.#changed()
  }

  // ---- back and forward lists ----

  history(id: string, direction: 'back' | 'forward'): NavigationEntry[] {
    const nav = this.get(id).view.webContents.navigationHistory
    const entries = nav.getAllEntries()
    const active = nav.getActiveIndex()
    const indices = direction === 'back'
      ? Array.from({ length: active }, (_, i) => active - 1 - i)
      : Array.from({ length: Math.max(0, entries.length - active - 1) }, (_, i) => active + 1 + i)
    return indices.slice(0, HISTORY_LIMIT).map((index) => {
      const entry = entries[index]
      return { index, url: entry?.url ?? '', title: entry?.title || entry?.url || '' }
    })
  }

  goToIndex(id: string, index: number): void {
    const tab = this.get(id)
    const nav = tab.view.webContents.navigationHistory
    if (!Number.isInteger(index) || index < 0 || index >= nav.length()) throw new Error('That history entry no longer exists.')
    tab.internalUrl = null
    nav.goToIndex(index)
    this.#applyLayout()
    this.#changed()
  }

  // ---- split view ----

  /** Shows the active tab next to the previously used one (or a new tab). */
  openSplit(): void {
    const active = this.active()
    if (!active) return
    const partner = this.find(this.#recent.find((r) => r !== active.id) ?? '') ?? this.create('about:blank', { activate: false, afterId: active.id })
    this.openSplitWith(active.id, partner.id)
  }

  /** Shows `id` next to `partnerId`, with `id` focused. */
  openSplitWith(id: string, partnerId: string): void {
    if (id === partnerId) throw new Error('A tab cannot be split with itself.')
    const partner = this.get(partnerId)
    const wasSplit = this.#split
    this.activate(id)
    // Left and right follow the list order (SH-39); `id` keeps the focus.
    const [left, right] = this.#listIndex(id) <= this.#listIndex(partnerId) ? [id, partnerId] : [partnerId, id]
    this.#split = { primaryId: left, secondaryId: right }
    if (!wasSplit || wasSplit.primaryId !== left || wasSplit.secondaryId !== right) this.#splitRatio = SPLIT_EVEN
    this.#wake(partner)
    this.#applyLayout()
    this.#changed()
  }

  closeSplit(): void {
    if (!this.#split) return
    this.#split = null
    this.#applyLayout()
    this.#changed()
  }

  swapSplit(): void {
    if (!this.#split) return
    this.#split = { primaryId: this.#split.secondaryId, secondaryId: this.#split.primaryId }
    this.#applyLayout()
    this.#changed()
  }

  split(): SplitState | null {
    return this.#split ? { ...this.#split } : null
  }

  // ---- queries ----

  get(id: string): Tab {
    const tab = this.find(id)
    if (!tab) throw new Error(`No tab with id ${id}.`)
    return tab
  }

  find(id: string): Tab | undefined {
    return this.#tabs.find((t) => t.id === id)
  }

  active(): Tab | null {
    return this.#activeId ? (this.find(this.#activeId) ?? null) : null
  }

  activeId(): string | null {
    return this.#activeId
  }

  all(): readonly Tab[] {
    return this.#tabs
  }

  byWebContents(webContents: WebContents): Tab | undefined {
    return this.#tabs.find((t) => t.view.webContents === webContents)
  }

  /** True while the chrome draws this tab itself: an apex:// page, the new tab or an error page. */
  isChromeDrawn(tab: Tab): boolean {
    return tab.internalUrl !== null || isBlankUrl(tab.view.webContents.getURL()) || this.#covered(tab)
  }

  // Error, interstitial and crash pages are drawn by the chrome in the pane
  /** Hides a tab's view while `fn` says the chrome draws over its pane; returns the removal. */
  cover(fn: (tab: Tab) => boolean): () => void {
    this.#covers.push(fn)
    this.#applyLayout()
    return () => {
      const i = this.#covers.indexOf(fn)
      if (i >= 0) this.#covers.splice(i, 1)
      this.#applyLayout()
    }
  }

  /** Re-applies view visibility and re-publishes tab info after a cover's answer changed. */
  recover(): void {
    this.#applyLayout()
    this.#changed()
  }

  #covered(tab: Tab): boolean {
    return this.#covers.some((fn) => fn(tab))
  }

  /** Re-publishes tab info when something it depends on changed (a chat title, a companion name). */
  refresh(): void {
    this.#changed()
  }

  // ---- layout ----

  setLayout(layout: LayoutBounds): void {
    const radius = layout.radius ?? this.#layout.radius ?? 0
    const radiusChanged = radius !== (this.#layout.radius ?? 0)
    this.#layout = { ...layout, radius }
    if (radiusChanged) for (const tab of this.#tabs) tab.view.setBorderRadius(radius)
    this.#applyLayout()
  }

  /** The panes as the chrome last measured them (the tear-off finds the content card here). */
  layoutBounds(): LayoutBounds {
    return { ...this.#layout }
  }

  /** The bounds of the active tab's view (its pane in split view). */
  contentBounds(): Bounds {
    if (this.#rail !== null) return NO_BOUNDS
    if (this.#split && this.#layout.secondary && this.#activeId === this.#split.secondaryId) return this.#layout.secondary
    return this.#layout.primary
  }

  // Overlay anchors relative to a tab's pane
  /** A showing tab's pane in window px (its split side), or null when it isn't showing. */
  paneBounds(id: string): Bounds | null {
    if (this.#rail !== null) return null
    return this.#boundsFor(id)
  }

  /** The tabs whose pages show right now (the active one, or both split panes). */
  visibleIds(): string[] {
    if (this.#rail !== null) return []
    const split = this.#split
    if (split && this.#layout.secondary) return [split.primaryId, split.secondaryId]
    return this.#activeId ? [this.#activeId] : []
  }

  /** Hides pages while a chrome overlay or the peek needs to be on top. */
  setHidden(reason: string, hidden: boolean): void {
    if (hidden) this.#hiddenReasons.add(reason)
    else this.#hiddenReasons.delete(reason)
    this.#applyLayout()
  }

  isHidden(): boolean {
    return this.#hiddenReasons.size > 0
  }

  /** A page is in HTML full screen and fills the window. */
  pageFullScreen(): boolean {
    return this.#fullScreenId !== null
  }

  /**
   * A small JPEG of what the tab shows, for blurred backdrops. apex:// pages
   * and the new tab are drawn by the chrome, so its content area is captured.
   */
  async capture(id: string, chrome: WebContents): Promise<string | null> {
    const tab = this.get(id)
    let image: Electron.NativeImage
    if (this.isChromeDrawn(tab)) {
      const bounds = this.#boundsFor(tab.id) ?? this.#layout.primary
      if (bounds.width === 0 || bounds.height === 0) return null
      // Layout bounds are window pixels; the chrome captures in its own (zoomed) CSS pixels.
      const zoom = chrome.getZoomFactor() || 1
      image = await chrome.capturePage({ x: Math.round(bounds.x / zoom), y: Math.round(bounds.y / zoom), width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) })
    } else {
      // A background tab (hover cards, the switcher) is captured without being shown.
      const shown = this.#boundsFor(tab.id) !== null && !this.isHidden() && this.#rail === null
      image = await tab.view.webContents.capturePage(undefined, { stayHidden: !shown })
    }
    if (image.isEmpty()) return null
    const { width } = image.getSize()
    const small = width > SNAPSHOT_WIDTH ? image.resize({ width: SNAPSHOT_WIDTH, quality: 'good' }) : image
    return `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}`
  }

  #boundsFor(id: string): Bounds | null {
    const split = this.#split
    if (split && this.#layout.secondary && split.secondaryId === id) return this.#layout.secondary
    if (split ? split.primaryId === id : this.#activeId === id) return this.#layout.primary
    return null
  }

  /**
   * Places and shows views: only the active tab (or both split panes), and
   * not while blank or on an Apex page, where the chrome draws instead. A
   * page in HTML full screen fills the window on its own. A page an agent
   * works in keeps painting while it isn't showing: it sits outside the
   * window at the page area's size (#offstage), so the agent sees and clicks
   * it there while the person uses another tab.
   */
  #applyLayout(): void {
    const panes = new Map<string, Bounds>()
    const split = this.#split
    const fullScreen = this.#fullScreenId
    if (fullScreen) {
      const { width, height } = this.#options.window.getContentBounds()
      panes.set(fullScreen, { x: 0, y: 0, width, height })
    } else if (split && this.#layout.secondary && this.#rail === null) {
      panes.set(split.primaryId, this.#layout.primary)
      panes.set(split.secondaryId, this.#layout.secondary)
    } else if (this.#activeId && this.#rail === null) {
      panes.set(this.#activeId, this.#layout.primary)
    }
    for (const tab of this.#tabs) {
      const bounds = panes.get(tab.id)
      const covered = !fullScreen && this.#hiddenReasons.size > 0
      const page = !tab.internalUrl && !isBlankUrl(tab.view.webContents.getURL()) && !this.#covered(tab)
      const visible = bounds !== undefined && !covered && page
      const offstage = !visible && page && tab.agentControlled
      if (offstage) tab.view.setBounds(this.#offstage())
      else if (bounds) tab.view.setBounds(bounds)
      tab.view.setVisible(visible || offstage)
    }
  }

  /**
   * Where a working agent tab that isn't showing paints: the page area's size,
   * outside the window but for one point in its bottom-left corner, under the
   * window's rounded corner. Chromium hides a view wholly outside its window,
   * and a hidden page stops painting; that one point keeps it drawing.
   */
  #offstage(): Bounds {
    const { width, height } = this.#layout.primary
    const window = this.#options.window.getContentBounds()
    return { x: 1 - width, y: window.height - 1, width, height }
  }

  // ---- page full screen ----

  #enterPageFullScreen(tab: Tab): void {
    this.#fullScreenWasNative = this.#options.window.isFullScreen()
    if (this.#activeId !== tab.id) {
      this.#activeId = tab.id
      this.#recent = [tab.id, ...this.#recent.filter((r) => r !== tab.id)]
    }
    this.#fullScreenId = tab.id
    this.#applyLayout()
    this.emit('page-fullscreen', true)
    this.#changed()
  }

  #endPageFullScreen(): void {
    if (!this.#fullScreenId) return
    this.#fullScreenId = null
    this.#applyLayout()
    this.emit('page-fullscreen', false)
  }

  /** Asks the page to leave full screen (it can't stay while another tab comes forward). */
  #exitPageFullScreen(): void {
    const tab = this.find(this.#fullScreenId ?? '')
    this.#endPageFullScreen()
    if (tab && !tab.view.webContents.isDestroyed()) {
      // The isolated world shares the DOM, so the page's own script isn't involved.
      void tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'document.fullscreenElement && document.exitFullscreen()' }]).catch(() => undefined)
    }
    const window = this.#options.window
    if (!this.#fullScreenWasNative && window.isFullScreen()) window.setFullScreen(false)
  }

  // ---- agent state ----

  /** Marks a tab as driven by a chat's agent; `chatId` names the chat (null when unknown). */
  setAgentControlled(id: string, controlled: boolean, chatId: string | null = null): void {
    const tab = this.find(id)
    const nextChat = controlled ? chatId : null
    if (!tab || (tab.agentControlled === controlled && tab.agentChatId === nextChat)) return
    const wasControlled = tab.agentControlled
    tab.agentControlled = controlled
    tab.agentChatId = nextChat
    if (!controlled) tab.needsInput = false
    const wc = tab.view.webContents
    if (!wc.isDestroyed() && wasControlled !== controlled) {
      // Keep rendering and timers live while the agent works, even if the
      // user switches to another app and Apex is covered.
      wc.setBackgroundThrottling(!controlled)
      // The agent's input debugger is attached on first use; release it with the tab.
      if (!controlled) detachInput(wc)
    }
    // A tab the agent takes paints out of sight while it isn't showing, and stops when it lets go.
    if (wasControlled !== controlled) this.#applyLayout()
    this.#sendOverlay(tab)
    this.#changed()
  }

  /** The tab's chat is waiting on the user (an approval or a question). */
  setNeedsInput(id: string, needsInput: boolean): void {
    const tab = this.find(id)
    if (!tab || tab.needsInput === needsInput) return
    tab.needsInput = needsInput
    this.#changed()
  }

  /** Re-sends the overlay's look to every controlled tab (theme, accent or companion changed). */
  refreshAgentOverlay(): void {
    for (const tab of this.#tabs) if (tab.agentControlled) this.#sendOverlay(tab)
  }

  #sendOverlay(tab: Tab): void {
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return
    const look = this.#options.agentOverlay?.(tab) ?? { accent: '', onAccent: '', label: '' }
    const overlay: AgentOverlay = { active: tab.agentControlled, ...look }
    wc.send(PAGE.agentState, overlay)
  }

  // Decorators, selection, groups and tear-off from here

  /** Adds TabInfo fields from a feature's own state; returns the removal. */
  decorate(provider: TabDecorator): () => void {
    this.#decorators.push(provider)
    this.#changed()
    return () => {
      const i = this.#decorators.indexOf(provider)
      if (i >= 0) this.#decorators.splice(i, 1)
      this.#changed()
    }
  }

  setSelection(ids: string[]): void {
    this.#selection = ids.filter((id) => this.find(id))
    this.#changed()
  }

  selection(): string[] {
    return [...this.#selection]
  }

  /**
   * Detaches a tab for a move to another window (tear-off, move to window).
   * Its page lives on: the view leaves this window and the caller hands the
   * tab to the other manager's adopt(). The window falls back to its
   * previous tab.
   */
  release(id: string): Tab {
    const index = this.#tabs.findIndex((t) => t.id === id)
    const [tab] = index === -1 ? [] : this.#tabs.splice(index, 1)
    if (!tab) throw new Error(`No tab with id ${id}.`)
    if (this.#split && (this.#split.primaryId === id || this.#split.secondaryId === id)) this.#split = null
    if (this.#fullScreenId === id) this.#exitPageFullScreen()
    this.#recent = this.#recent.filter((r) => r !== id)
    this.#selection = this.#selection.filter((s) => s !== id)
    this.#groups.remove([id])
    this.#unwire.get(id)?.()
    this.#unwire.delete(id)
    this.#options.bridge.rejectAll(tab.view.webContents.id, 'The tab moved to another window.')
    this.#options.window.contentView.removeChildView(tab.view)
    this.#pageLeft(tab)
    // Carry the sleeping page's history with the tab.
    const asleep = this.#asleep.get(id)
    this.#asleep.delete(id)
    this.#restoringIds.delete(id)
    releasedHistory.set(tab, asleep ?? null)
    this.emit('closed', tab, { moved: true })
    if (tab.pinned) this.#savePinned()
    if (this.#activeId === id) {
      this.#activeId = null
      const next = this.find(this.#recent[0] ?? '') ?? this.#tabs[Math.min(index, this.#tabs.length - 1)]
      if (next) this.activate(next.id)
    }
    if (this.#tabs.length === 0) this.create()
    this.#applyLayout()
    this.#changed()
    return tab
  }

  /** Takes in a tab released by another window's manager and shows it here. */
  adopt(tab: Tab, index?: number): void {
    if (this.find(tab.id)) return
    const options: CreateTabOptions = index === undefined ? {} : { index }
    this.#tabs.splice(this.#insertIndex(tab, options), 0, tab)
    const asleep = releasedHistory.get(tab)
    releasedHistory.delete(tab)
    if (asleep) this.#asleep.set(tab.id, asleep)
    tab.view.setBorderRadius(this.#layout.radius ?? 0)
    tab.view.setVisible(false)
    this.#options.window.contentView.addChildView(tab.view)
    this.#wire(tab)
    this.emit('created', tab, { moved: true })
    this.activate(tab.id)
    if (tab.pinned) this.#savePinned()
    this.#changed()
  }

  /** The window's tabs for session.json: addresses, groups and back history. */
  serialize(): SavedTab[] {
    return this.#tabs.flatMap((tab) => this.#saved(tab) ?? [])
  }

  /** One tab as session.json keeps it, or null when its address isn't worth restoring. */
  #saved(tab: Tab): SavedTab | null {
    const url = this.#urlOf(tab)
    if (!isRestorableUrl(url)) return null
    const title = this.info(tab).title
    const asleep = this.#asleep.get(tab.id)
    let history: SavedHistory
    if (tab.internalUrl) history = { entries: [{ url, title }], index: 0 }
    else if (asleep) history = asleep
    else {
      const nav = tab.view.webContents.navigationHistory
      const entries = nav.getAllEntries().map((e) => ({ url: e.url, title: e.title })).filter((e) => isRestorableUrl(e.url))
      const active = Math.max(0, entries.findIndex((e) => e.url === url))
      history = trimHistory({ entries: entries.length ? entries : [{ url, title }], index: entries.length ? Math.min(nav.getActiveIndex(), entries.length - 1, Math.max(active, 0)) : 0 })
    }
    return { url, title, pinned: tab.pinned, groupId: this.#groups.groupOf(tab.id), entries: history.entries, index: history.index }
  }

  /**
   * Restores saved tabs. With `lazy`, each page loads with
   * its history only when it is first shown. Groups, the split and the
   * active tab come back too when given.
   */
  restore(
    saved: SavedTab[],
    opts: { lazy: true; groups?: SavedGroup[]; split?: { primary: number; secondary: number; ratio: number } | null; activeIndex?: number },
  ): void {
    this.#groups.restore(opts.groups ?? [])
    const created: Tab[] = []
    this.#restoring = true
    try {
      for (const item of saved) {
        if (!isRestorableUrl(item.url)) continue
        const tab = isInternalUrl(item.url)
          ? this.create(item.url, { activate: false, pinned: item.pinned })
          : this.create('about:blank', { activate: false, pinned: item.pinned, history: { entries: item.entries.length ? item.entries : [{ url: item.url, title: item.title }], index: item.entries.length ? item.index : 0 } })
        if (item.groupId && !item.pinned) this.#groups.assign(tab.id, item.groupId)
        created.push(tab)
      }
    } finally {
      this.#restoring = false
    }
    this.#groups.prune()
    for (const g of this.#groups.all()) this.#regroup(g.id)
    if (saved.some((t) => t.pinned)) this.#savePinned()
    const active = created[opts.activeIndex ?? -1]
    if (active) this.activate(active.id)
    const split = opts.split
    const left = split ? created[split.primary] : undefined
    const right = split ? created[split.secondary] : undefined
    if (split && left && right && left !== right) {
      this.openSplitWith(active === right ? right.id : left.id, active === right ? left.id : right.id)
      this.#splitRatio = clampRatio(split.ratio)
    }
    this.#changed()
  }

  #stateFields(tab: Tab, url: string): TabStateFields {
    const wc = tab.view.webContents
    const alive = !wc.isDestroyed()
    const loading = alive && wc.isLoading()
    const base = {
      windowId: this.#options.windowId ?? 1,
      loadStage: loading ? 'started' : isBlankUrl(url) ? 'idle' : 'finished',
      loadStartedAt: null,
      zoomPercent: alive ? Math.round(wc.getZoomFactor() * 100) : 100,
      groupId: this.#groups.groupOf(tab.id),
      sleeping: this.#asleep.has(tab.id),
      restoring: this.#restoringIds.has(tab.id),
      security: tab.internalUrl ? 'internal' : /^https:/i.test(url) ? 'secure' : /^http:/i.test(url) ? 'insecure' : 'none',
      capture: { camera: false, microphone: false, screen: false },
      pageError: null,
      crashed: alive && wc.isCrashed(),
      unresponsive: false,
    } satisfies Partial<TabInfo>
    let out: Partial<TabInfo> = base
    for (const decorate of this.#decorators) out = { ...out, ...decorate(tab) }
    return out as TabStateFields
  }


  groups(): TabGroup[] {
    return this.#groups.all()
  }

  groupOf(tabId: string): string | null {
    return this.#groups.groupOf(tabId)
  }

  /** A new group from these tabs (pinned tiles stay out), gathered into one block where the first one sits. */
  createGroup(tabIds: readonly string[], name?: string): TabGroup {
    const ids = tabIds.filter((id) => this.find(id) && !this.get(id).pinned)
    if (ids.length === 0) throw new Error('Pinned tabs can’t join a group.')
    const group = this.#groups.create(ids, name)
    this.#regroup(group.id)
    this.#selection = []
    this.#changed()
    return group
  }

  updateGroup(id: string, patch: { name?: string; color?: TabGroup['color']; collapsed?: boolean }): TabGroup {
    const group = this.#groups.update(id, patch)
    // Collapsing the group that holds the active tab moves you to the nearest tab outside it.
    if (patch.collapsed && this.#activeId && this.#groups.groupOf(this.#activeId) === id) {
      const outside = this.#recent.find((r) => this.#groups.groupOf(r) !== id && this.find(r))
      if (outside) {
        this.activate(outside)
        this.#groups.update(id, { collapsed: true })
      }
    }
    this.#changed()
    return this.#groups.get(id) ?? group
  }

  addToGroup(id: string, tabIds: readonly string[]): void {
    const ids = tabIds.filter((t) => this.find(t) && !this.get(t).pinned)
    const order = this.#tabs.map((t) => t.id)
    const before = new Set(this.#groups.tabsOf(id, order))
    this.#groups.add(id, ids)
    if (before.size > 0) this.#reorder(joinBlock(order, before, ids))
    else this.#regroup(id)
    this.#changed()
  }

  removeFromGroup(tabIds: readonly string[]): void {
    this.#groups.remove(tabIds)
    this.#changed()
  }

  /** Ends the group; its tabs stay where they are. */
  ungroup(id: string): void {
    this.#groups.ungroup(id)
    this.#changed()
  }

  /** Closes every tab in the group. */
  closeGroup(id: string): number {
    const ids = this.#groups.tabsOf(id, this.#tabs.map((t) => t.id))
    this.#groups.ungroup(id)
    let closed = 0
    for (const tabId of ids) {
      if (!this.find(tabId)) continue
      this.close(tabId)
      closed++
    }
    this.#changed()
    return closed
  }

  /** ⌥⌘T: a new tab at the end of the group (the active tab's group when none is named). */
  newTabInGroup(id?: string): Tab {
    const groupId = id ?? (this.#activeId ? this.#groups.groupOf(this.#activeId) : null)
    if (!groupId) return this.create('about:blank', { afterId: this.#activeId ?? undefined })
    this.#groups.update(groupId, { collapsed: false })
    const last = this.#groups.tabsOf(groupId, this.#tabs.map((t) => t.id)).at(-1)
    return this.create('about:blank', { afterId: last, groupId })
  }

  /** ⌘W with a selection: closes the selected tabs, pinned ones excepted. */
  closeSelection(): number {
    const ids = this.#selection.slice()
    this.#selection = []
    const closed = this.closeMany(ids)
    this.#changed()
    return closed
  }

  /** ⌃⇧PageUp/PageDown: moves the active tab one place in the manual order (SH-20). */
  moveActive(delta: 1 | -1): void {
    const tab = this.active()
    if (!tab) return
    const ids = this.#tabs.map((t) => t.id)
    const pinnedCount = this.#pinnedCount()
    const bounds = tab.pinned ? { min: 0, max: pinnedCount - 1 } : { min: pinnedCount, max: ids.length - 1 }
    const result = moveOne(ids, tab.id, delta, (id) => this.#groups.groupOf(id), bounds)
    if (result.leaveGroup) {
      this.#groups.remove([tab.id])
    } else {
      this.#reorder(result.ids)
    }
    if (tab.pinned) this.#savePinned()
    this.emit('moved', tab, this.#tabs.indexOf(tab))
    this.#changed()
  }

  /** Tab ids, most recently used first. */
  recent(): string[] {
    return this.#recent.filter((id) => this.find(id))
  }

  /** The previous tab in recent order (a quick ⌃Tab tap flips to it). */
  flipRecent(): void {
    const previous = this.#recent.find((id) => id !== this.#activeId && this.find(id))
    if (previous) this.activate(previous)
  }

  splitRatio(): number {
    return this.#splitRatio
  }

  /** The left pane's share, 0.2 to 0.8, saved with the window. */
  setSplitRatio(ratio: number): void {
    const next = clampRatio(ratio)
    if (next === this.#splitRatio) return
    this.#splitRatio = next
    this.#changed()
  }

  /** Closes the left or right page; the other one stays as a normal tab. */
  closeSplitSide(side: 'left' | 'right'): void {
    const split = this.#split
    if (!split) return
    const [closing, staying] = side === 'left' ? [split.primaryId, split.secondaryId] : [split.secondaryId, split.primaryId]
    this.#split = null
    this.activate(staying)
    this.close(closing)
  }

  /** The empty pane's chooser: shows `tabId` in place of the blank page, which closes. */
  chooseSplit(tabId: string): void {
    const split = this.#split
    if (!split) throw new Error('There’s no split view to fill.')
    if (tabId === split.primaryId || tabId === split.secondaryId) return
    this.get(tabId)
    const blank = [split.primaryId, split.secondaryId].find((id) => isBlankUrl(this.#urlOf(this.get(id))))
    const keep = blank === split.primaryId ? split.secondaryId : split.primaryId
    this.openSplitWith(keep, tabId)
    if (blank && blank !== keep) this.close(blank)
  }

  /** The link menu's Open in Split View (and the agent): the page opens beside the active tab. */
  openSplitUrl(url: string): Tab {
    const active = this.active()
    const tab = this.create(url, { activate: false, afterId: active?.id })
    if (active) this.openSplitWith(active.id, tab.id)
    else this.activate(tab.id)
    return tab
  }

  /** Puts a background tab's page to sleep: a fresh empty view replaces it, and its history comes back on wake. */
  sleep(id: string): void {
    const tab = this.get(id)
    if (this.#asleep.has(id) || tab.internalUrl || id === this.#activeId) return
    const old = tab.view
    const wc = old.webContents
    if (wc.isDestroyed()) return
    const nav = wc.navigationHistory
    const entries = nav.getAllEntries().map((e) => ({ url: e.url, title: e.title }))
    if (entries.length === 0 || isBlankUrl(wc.getURL())) return
    const history = trimHistory({ entries, index: nav.getActiveIndex(), favicon: tab.favicon })
    this.#asleep.set(id, { ...history, url: wc.getURL(), title: wc.getTitle() || wc.getURL() })
    this.#unwire.get(id)?.()
    tab.view = this.#makeView(tab.sandbox) // An artifact tab stays in its sandbox
    tab.view.setVisible(false)
    this.#options.window.contentView.addChildView(tab.view)
    this.#wire(tab)
    this.#options.bridge.rejectAll(wc.id, 'The tab went to sleep.')
    this.#options.window.contentView.removeChildView(old)
    this.emit('view-replaced', tab, wc)
    wc.close()
    this.#changed()
  }

  isAsleep(id: string): boolean {
    return this.#asleep.has(id)
  }

  /** The media card's tab (mediaSessions.ts provides it). */
  setMediaSource(source: (() => TabMedia | null) | null): void {
    this.#media = source
  }

  #wake(tab: Tab): void {
    const asleep = this.#asleep.get(tab.id)
    if (!asleep) return
    this.#asleep.delete(tab.id)
    if (tab.internalUrl) return
    this.#restoringIds.add(tab.id)
    tab.requestedUrl = asleep.url
    if (asleep.favicon) tab.favicon = asleep.favicon
    const wc = tab.view.webContents
    try {
      wc.navigationHistory.restore({ index: asleep.index, entries: asleep.entries })
    } catch {
      // A view that already navigated can't take a history: load the page itself.
      void wc.loadURL(asleep.url).catch(() => undefined)
    }
  }

  /** A view around the page Chromium created for window.open (it inherited the opener tab's preferences). */
  #adoptView(guest: NonNullable<CreateTabOptions['guest']>): WebContentsView {
    const view = new WebContentsView({ webContents: guest.webContents, ...(guest.webPreferences ? { webPreferences: guest.webPreferences } : {}) })
    view.setBorderRadius(this.#layout.radius ?? 0)
    return view
  }

  /** A page tab's preferences without its session: the tab a window.open makes is created with these (sign-in compatibility). */
  pageWebPreferences(): Electron.WebPreferences {
    const { session: _session, ...prefs } = this.#pagePreferences()
    return prefs
  }

  #makeView(sandbox?: Session): WebContentsView {
    const view = new WebContentsView({ webPreferences: this.#pagePreferences(sandbox) })
    // Square while the page is flush in the sheet; rounded while it is inset beside a chat (the chrome reports which).
    view.setBorderRadius(this.#layout.radius ?? 0)
    return view
  }

  #pagePreferences(sandbox?: Session): Electron.WebPreferences {
    return {
      // A sandboxed (artifact) view gets no preload and its own session.
      // The page preload hears whether the system passkey sheet is on (signInCompat.ts).
      ...(sandbox ? {} : { preload: this.#options.preloadPath, additionalArguments: pagePasskeyArguments() }),
      session: sandbox ?? this.#options.session,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The page preload runs in every frame too (sandboxed, isolated), so autofill works in nested and cross-origin frames.
      nodeIntegrationInSubFrames: true,
      webviewTag: false,
      safeDialogs: true,
      // Page dialogs go through Apex's own (preload/page/dialogs.ts); any that slip past fail closed.
      disableDialogs: true,
      spellcheck: true,
    }
  }

  #forget(tab: Tab): void {
    this.#groups.remove([tab.id])
    this.#asleep.delete(tab.id)
    this.#restoringIds.delete(tab.id)
    this.#unwire.get(tab.id)?.()
    this.#unwire.delete(tab.id)
  }

  /** Where a tab sits in the list the person sees (the reported order), else main's order. */
  #listIndex(id: string): number {
    const reported = this.#order?.findIndex((e) => e.kind === 'tab' && e.id === id) ?? -1
    if (reported !== -1) return reported
    return 10_000 + this.#tabs.findIndex((t) => t.id === id)
  }

  /** Rebuilds the manual order from ids, keeping pinned tabs first. */
  #reorder(ids: readonly string[]): void {
    const byId = new Map(this.#tabs.map((t) => [t.id, t]))
    const next = ids.map((id) => byId.get(id)).filter((t): t is Tab => t !== undefined)
    if (next.length !== this.#tabs.length) return
    this.#tabs.splice(0, this.#tabs.length, ...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned))
  }

  /** Keeps a group's tabs in one block of the manual order. */
  #regroup(groupId: string): void {
    const ids = this.#tabs.map((t) => t.id)
    const members = new Set(this.#groups.tabsOf(groupId, ids))
    this.#reorder(gatherGroup(ids, members))
  }

  /** After a drag: a tab dropped inside another group's block joins it; one dropped outside its own block leaves. */
  #placeInGroups(tab: Tab, index: number): void {
    if (tab.pinned) return
    const before = this.#tabs[index - 1]
    const after = this.#tabs[index + 1]
    const beforeGroup = before ? this.#groups.groupOf(before.id) : null
    const afterGroup = after ? this.#groups.groupOf(after.id) : null
    const own = this.#groups.groupOf(tab.id)
    if (beforeGroup !== null && beforeGroup === afterGroup) {
      if (own !== beforeGroup) this.#groups.add(beforeGroup, [tab.id])
    } else if (own !== null && beforeGroup !== own && afterGroup !== own) {
      this.#groups.remove([tab.id])
    }
  }

  info(tab: Tab): TabInfo {
    const wc = tab.view.webContents
    const common = {
      id: tab.id,
      agentControlled: tab.agentControlled,
      agentChatId: tab.agentChatId,
      needsInput: tab.needsInput,
      pinned: tab.pinned,
      audible: !wc.isDestroyed() && wc.isCurrentlyAudible(),
      muted: !wc.isDestroyed() && wc.isAudioMuted(),
      lastActiveAt: tab.lastActiveAt,
      ...this.#stateFields(tab, this.#urlOf(tab)),
    }
    if (tab.internalUrl) {
      const { title, crumbs } = internalTitle(tab.internalUrl, this.#options.names)
      return {
        ...common,
        title,
        url: tab.internalUrl,
        favicon: null,
        loading: false,
        canGoBack: !isBlankUrl(wc.getURL()) || wc.navigationHistory.canGoBack(),
        canGoForward: false,
        crumbs,
      }
    }
    const asleep = this.#asleep.get(tab.id)
    if (asleep) {
      return {
        ...common,
        title: asleep.title || asleep.url,
        url: asleep.url,
        favicon: asleep.favicon ?? tab.favicon,
        loading: false,
        canGoBack: asleep.index > 0,
        canGoForward: asleep.index < asleep.entries.length - 1,
        crumbs: null,
      }
    }
    const url = wc.getURL() || tab.requestedUrl
    return {
      ...common,
      // A blank page's own title is its address ("about:blank"); people know it as a new tab.
      title: isBlankUrl(url) ? mainT('tabs.mainTabs.newTab') : wc.getTitle() || url || mainT('tabs.mainTabs.newTab'),
      url,
      favicon: tab.favicon,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      crumbs: null,
    }
  }

  snapshot(): TabsSnapshot {
    return {
      tabs: this.#tabs.map((t) => this.info(t)),
      activeId: this.#activeId,
      split: this.split(),
      closedCount: this.#closed.size,
      rail: this.#railState(),
      groups: this.#groups.all(),
      selection: [...this.#selection],
      splitRatio: this.#splitRatio,
      media: this.#media?.() ?? null,
    }
  }

  #railState(): RailState | null {
    if (this.#rail === null) return null
    // The pill reads "Apex / ‹page›" (DS-99).
    const { title } = internalTitle(this.#rail, this.#options.names)
    return { url: this.#rail, title, crumbs: [BRAND_NAME, title] }
  }

  #pinnedCount(): number {
    return this.#tabs.filter((t) => t.pinned).length
  }

  #insertIndex(tab: Tab, options: CreateTabOptions): number {
    const pinnedCount = this.#pinnedCount()
    const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, this.#tabs.length]
    let index = max
    if (options.index !== undefined) index = options.index
    else if (options.afterId) {
      const after = this.#tabs.findIndex((t) => t.id === options.afterId)
      index = after === -1 ? max : after + 1
    } else if (options.position === 'top') index = min
    return Math.min(max, Math.max(min, index))
  }

  #urlOf(tab: Tab): string {
    const asleep = this.#asleep.get(tab.id)
    if (asleep && !tab.internalUrl) return asleep.url
    return tab.internalUrl ?? ((tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL()) || tab.requestedUrl)
  }

  #savePinned(): void {
    if (this.#restoring) return
    this.#options.pinned?.save(this.#tabs.filter((t) => t.pinned).map((t) => ({ url: this.#urlOf(t), title: this.info(t).title })))
  }

  // Feeds the visits log, activity memory and search
  readonly #visits = new Map<string, { url: string; at: number }>()

  #pageVisited(tab: Tab, url: string, title: string): void {
    if (!/^https?:/i.test(url)) return
    this.#pageLeft(tab)
    const at = Date.now()
    this.#visits.set(tab.id, { url, at })
    // Private windows and profiles supply the real window and profile here.
    this.emit('page-visited', { tabId: tab.id, url, title, at, agentControlled: tab.agentControlled, privateWindow: false, profileId: 'default' })
  }

  #pageLeft(tab: Tab): void {
    const visit = this.#visits.get(tab.id)
    if (!visit) return
    this.#visits.delete(tab.id)
    this.emit('page-left', { tabId: tab.id, url: visit.url, dwellMs: Math.max(0, Date.now() - visit.at) })
  }

  #changed(): void {
    this.emit('changed')
  }

  #wire(tab: Tab): void {
    const wc = tab.view.webContents
    const { history, bridge } = this.#options
    const changed = (): void => this.#changed()
    // Listeners are tracked so a tab moving to another window (or waking
    // in a fresh view) leaves nothing behind on this manager.
    const offs: (() => void)[] = []
    const on = ((event: string, fn: (...args: never[]) => void) => {
      wc.on(event as never, fn as never)
      offs.push(() => wc.removeListener(event as never, fn as never))
    }) as WebContents['on']
    this.#unwire.get(tab.id)?.()
    this.#unwire.set(tab.id, () => {
      for (const off of offs.splice(0)) off()
    })
    // A woken page shows skeleton rows until it reports its title (SS-01).
    const restored = (): void => {
      if (this.#restoringIds.delete(tab.id)) changed()
    }

    on('page-title-updated', (_e, title) => {
      history.updateTitle(wc.getURL(), title)
      if (this.#visits.get(tab.id)?.url === wc.getURL()) this.emit('page-titled', { tabId: tab.id, url: wc.getURL(), title })
      restored()
      changed()
    })
    on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = favicons.find((f) => /^https?:/i.test(f)) ?? null
      changed()
    })
    on('did-start-loading', changed)
    on('did-stop-loading', () => {
      restored()
      changed()
    })
    on('audio-state-changed', changed)
    on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        tab.favicon = null
        bridge.rejectAll(wc.id, 'The page navigated before it replied. Re-read the page.')
      }
    })
    on('did-navigate', (_e, url) => {
      history.record(url, wc.getTitle())
      this.#pageVisited(tab, url, wc.getTitle())
      tab.requestedUrl = url
      if (tab.pinned) this.#savePinned()
      this.#applyLayout()
      this.emit('navigated', tab, { url, mainFrame: true, inPage: false })
      changed()
    })
    on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) history.record(url, wc.getTitle())
      this.emit('navigated', tab, { url, mainFrame: isMainFrame, inPage: true })
      changed()
    })
    on('enter-html-full-screen', () => this.#enterPageFullScreen(tab))
    on('leave-html-full-screen', () => {
      if (this.#fullScreenId !== tab.id) return
      this.#endPageFullScreen()
      this.#changed()
    })
    on('focus', () => {
      // Clicking into the other split pane makes it the active tab.
      if (this.#split && this.#activeId !== tab.id && (this.#split.primaryId === tab.id || this.#split.secondaryId === tab.id)) {
        this.#activeId = tab.id
        tab.lastActiveAt = Date.now()
        changed()
      }
    })
    on('found-in-page', (_e, result) => {
      if (result.finalUpdate) this.#options.onFindResult?.({ matches: result.matches, active: result.activeMatchOrdinal })
    })
    on('dom-ready', () => {
      if (tab.agentControlled) this.#sendOverlay(tab)
    })
    on('will-navigate', (event) => {
      const scheme = safeProtocol(event.url)
      if (scheme && EXTERNAL_SCHEMES.has(scheme)) {
        event.preventDefault()
        // A pack's page never hands an address (and what it carries) to another app.
        if (!(tab.sandbox && /^apex-pack:/i.test(tab.view.webContents.getURL()))) void shell.openExternal(event.url)
      }
    })
    on('render-process-gone', changed)
    on('context-menu', (_e, params) => {
      // The contributed page menu; the built-in menu below stays as the fallback.
      if (showPageMenu(this, tab, params)) return
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.linkURL) {
        items.push(
          { label: mainT('tabs.mainTabs.openLinkNewTab'), click: () => this.create(params.linkURL, { activate: false, afterId: tab.id }) },
          ...(this.#options.onPeek && /^https?:/i.test(params.linkURL)
            ? [{ label: mainT('tabs.mainTabs.openLinkPeek'), click: () => this.#options.onPeek?.(params.linkURL) }]
            : []),
          { label: mainT('tabs.mainTabs.copyLinkAddress'), click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' },
        )
      }
      if (params.isEditable) {
        items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
      } else if (params.selectionText) {
        items.push({ role: 'copy' }, { type: 'separator' })
      }
      items.push(
        { label: mainT('tabs.mainTabs.back'), enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: mainT('tabs.mainTabs.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: mainT('tabs.mainTabs.reload'), click: () => wc.reload() },
        { type: 'separator' },
        { label: mainT('tabs.mainTabs.inspectElement'), click: () => wc.inspectElement(params.x, params.y) },
      )
      Menu.buildFromTemplate(items).popup({ window: this.#options.window })
    })
  }
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/** A released tab's sleeping history, carried to the adopting window. */
const releasedHistory = new WeakMap<Tab, (SavedHistory & { url: string; title: string }) | null>()

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_EVEN
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, Math.round(ratio * 1000) / 1000))
}

/** Keeps at most SAVED_HISTORY_LIMIT entries around the current one. */
export function trimHistory(h: SavedHistory): SavedHistory {
  const entries = h.entries.filter((e) => e.url).slice()
  if (entries.length === 0) return { entries: [], index: 0, favicon: h.favicon ?? null }
  let index = Math.min(Math.max(0, h.index), entries.length - 1)
  if (entries.length <= SAVED_HISTORY_LIMIT) return { entries, index, favicon: h.favicon ?? null }
  const start = Math.max(0, Math.min(index - Math.floor(SAVED_HISTORY_LIMIT / 2), entries.length - SAVED_HISTORY_LIMIT))
  index -= start
  return { entries: entries.slice(start, start + SAVED_HISTORY_LIMIT), index, favicon: h.favicon ?? null }
}
