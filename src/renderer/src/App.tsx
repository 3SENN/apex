/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { ChatSummary } from '@shared/chats'
import { DEFAULT_PROFILE, type Companion } from '@shared/companion'
import type { SettingsView, TabInfo, TabsSnapshot, WindowState } from '@shared/ipc'
import type { Bookmark, DownloadInfo, PeekState, Routine } from '@shared/services'
import { chatUrl, isBlankUrl, isInternalUrl, parseInternalUrl } from '@shared/url'
import { apex, call, errorText } from './api'
import { AgentPanel } from './components/AgentPanel'
import { BookmarksBar } from './components/bars/BookmarksBar'
import { Rail as NavRail } from './components/rail/Rail'
import { railShown } from './components/sidebar/logic/rail'
import { useDockChoice } from './settings/dockChoice'
import { useSpaceSnapshot } from './workspace/spaceView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { noteComposerOrigin, noteStanding } from './chat/handoff'
import { TabPaneBody } from './chat/ChatInTab' // DS-65
import { collapseToPanel, heldChat, pruneHeldChats, useHeldChats } from './chat/surfaces' // DS-65
import { NewTabPage } from './components/NewTabPage'
import { takeAskHandoff } from './components/newtab/handoff'
import { CompanionsContext, ShellContext, type ShellActions } from './components/shellContext'
import { chatCounts } from './components/sidebar/logic/menus'
import { chatIdOfUrl, sidebarFits } from './components/sidebar/logic/order'
import { TRAFFIC_HEIGHT, measureTrafficFrame, trafficPlacement } from './components/sidebar/logic/traffic'
import { Sidebar } from './components/sidebar/Sidebar'
import { TabStrip } from './components/TabStrip'
import { SplitChooser, SplitSeam, splitStyle } from './components/split'
import { Toolbar, type ToolbarHandle } from './components/Toolbar'
import { CompanionCard } from './pages/CompanionCard'
import { InternalPage } from './pages/InternalPage'
import { PageErrorView, showsPageError } from './pages/errors/PageErrorView'
import { ReaderView } from './reader/ReaderView' // reader (RD-02)
import { DiagnosticsLayer } from './diagnostics/DiagnosticsLayer'
import { SystemLayer } from './system/SystemLayer'
import { UpdatesLayer } from './updates/UpdatesLayer'
import { AtWorkLayer } from './overlay/surfaces/chat/AtWorkLayer'
import { useVoicePanel } from './voice/useVoicePanel'
import { Button, Dialog, MOTION, UiHost, applyMotionSetting, applyProfileHue, cx, followFrames, toast, useLayerPresence } from './ui'
import { useT } from './i18n/useT'

const PANEL_OPEN_KEY = 'apex.agentOpen'
const CLOSED_PEEK: PeekState = { open: false, url: '', title: '', loading: false }

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_OPEN_KEY) !== 'false'
  } catch {
    return true
  }
}

function savePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_OPEN_KEY, String(open))
  } catch {
    // Storage can be unavailable; the panel still toggles.
  }
}

type Slot = 'primary' | 'secondary'

/** DS-05: the Window Controls Overlay; macOS chrome windows turn it on only to measure the traffic lights. */
type ControlsOverlay = EventTarget & { visible: boolean; getTitlebarAreaRect(): DOMRect }
const controlsOverlay = (): ControlsOverlay | null => (navigator as unknown as { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay ?? null

/**
 * Where the macOS window controls go: the [data-traffic-slot] in the sidebar
 * header (or the tab strip), reported to main. They travel with the sidebar
 * as it slides away and hide once it is collapsed; the returned report runs
 * every frame of a layout change.
 *
 * DS-05: they are centred on the slot with their real frame height, not an
 * assumed one: after each move main returns the margin AppKit took, and the
 * overlay strip beside the buttons gives the frame (measureTrafficFrame).
 */
function useTrafficLights(enabled: boolean): RefObject<() => void> {
  const last = useRef('')
  const report = useRef<() => void>(() => undefined)
  const frame = useRef(TRAFFIC_HEIGHT)
  const applied = useRef<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!enabled) {
      // Full screen manages the controls itself: give them back if they were hidden.
      if (last.current === 'hidden') void call('window', 'setButtonsVisible', true)
      last.current = ''
      report.current = () => undefined
      return
    }
    // A measured frame that differs from the one in use re-centres the controls (once: the next measure agrees).
    const measure = (): void => {
      const overlay = controlsOverlay()
      const measured = measureTrafficFrame(overlay?.visible ? overlay.getTitlebarAreaRect() : null, applied.current)
      if (!measured || measured.height === frame.current) return
      frame.current = measured.height
      report.current()
    }
    report.current = () => {
      const placement = trafficPlacement(document.querySelector<HTMLElement>('[data-traffic-slot]')?.getBoundingClientRect() ?? null, frame.current)
      const key = placement.visible ? `${placement.x},${placement.y}` : 'hidden'
      if (key === last.current) return
      const wasHidden = last.current === 'hidden'
      last.current = key
      if (!placement.visible) {
        void call('window', 'setButtonsVisible', false)
        return
      }
      void call('window', 'setButtonPosition', { x: placement.x, y: placement.y }).then((margin) => {
        applied.current = margin ?? null
        measure()
      }, () => undefined)
      if (wasHidden) void call('window', 'setButtonsVisible', true)
    }
    report.current()
    const onResize = (): void => report.current()
    const overlay = controlsOverlay()
    window.addEventListener('resize', onResize)
    overlay?.addEventListener('geometrychange', measure)
    return () => {
      window.removeEventListener('resize', onResize)
      overlay?.removeEventListener('geometrychange', measure)
    }
  })
  return report
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth)
  useEffect(() => {
    const update = (): void => setWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return width
}

function RenameWindowDialog({ open, current, onClose }: { open: boolean; current: string | null; onClose(): void }): ReactElement | null {
  const t = useT()
  const [name, setName] = useState(current ?? '')
  useEffect(() => {
    if (open) setName(current ?? '')
  }, [open, current])
  const save = (value: string | null): void => {
    void call('window', 'setName', value?.trim() || null)
    onClose()
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={t('core.app.nameThisWindow')}
      description={t('core.app.theNameShowsIn')}
      footer={
        <>
          {current && (
            <Button variant="ghost" onClick={() => save(null)}>
              {t('core.app.useTabTitle')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t('core.app.cancel')}
          </Button>
          <Button variant="primary" onClick={() => save(name)}>
            {t('core.app.save')}
          </Button>
        </>
      }
    >
      <input
        className="shell-input"
        data-autofocus
        value={name}
        maxLength={80}
        placeholder={t('core.app.forExampleResearch')}
        aria-label={t('core.app.windowName')}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save(name)
          }
        }}
      />
    </Dialog>
  )
}

export function App(): ReactElement {
  const t = useT()
  const [allTabs, setSnapshot] = useState<TabsSnapshot>(apex.initial.tabs)
  // The chrome shows only the active space's tabs (pinned tabs stay in every space).
  const snapshot = useSpaceSnapshot(allTabs)
  const [settings, setSettings] = useState<SettingsView>(apex.initial.settings)
  const [windowState, setWindowState] = useState<WindowState>(apex.initial.window)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [companions, setCompanions] = useState<{ list: Companion[]; activeId: string }>({ list: [], activeId: '' })
  const [routines, setRoutines] = useState<Routine[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [downloads, setDownloads] = useState<DownloadInfo[]>([])
  const [peek, setPeek] = useState<PeekState>(CLOSED_PEEK)
  const [panelOpen, setPanelOpen] = useState(readPanelOpen)
  // A chat the panel should attach once; cleared after it mounted with it.
  const [panelRequest, setPanelRequest] = useState<string | null>(null)
  const [remount, setRemount] = useState<Record<string, number>>({})
  const [card, setCard] = useState<{ companionId: string; section: string | null; item?: string | null } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [liveSidebarWidth, setLiveSidebarWidth] = useState<number | null>(null)
  const [forceSidebar, setForceSidebar] = useState(false)
  const toolbar = useRef<ToolbarHandle>(null)
  const slots = useRef<Record<Slot, HTMLDivElement | null>>({ primary: null, secondary: null })
  const peekFrame = useRef<HTMLDivElement>(null)
  const windowWidth = useWindowWidth()
  const isMac = apex.platform === 'darwin'

  useEffect(() => {
    const offs = [
      apex.tabs.onChanged(setSnapshot),
      apex.onAppEvent((event) => {
        switch (event.type) {
          case 'settings':
            setSettings(event.view)
            break
          case 'window':
            setWindowState(event.state)
            break
          case 'chats':
            setChats(event.items)
            break
          case 'companions':
            setCompanions({ list: event.items, activeId: event.activeId })
            break
          case 'companion':
            setCompanions((c) => ({ activeId: event.profile.id, list: c.list.some((x) => x.id === event.profile.id) ? c.list.map((x) => (x.id === event.profile.id ? event.profile : x)) : [...c.list, event.profile] }))
            break
          case 'routines':
            setRoutines(event.items)
            break
          case 'bookmarks':
            setBookmarks(event.items)
            break
          case 'downloads':
            setDownloads(event.items)
            break
          case 'peek':
            setPeek(event.state)
            break
          case 'reload-page':
            setRemount((r) => ({ ...r, [event.tabId]: (r[event.tabId] ?? 0) + 1 }))
            break
        }
      }),
    ]
    const warn = (what: string) => (err: unknown): void => console.warn(`${what} could not be loaded:`, errorText(err))
    // The initial state may be a beat old by the time React runs; refresh the parts that move.
    void apex.settings.get().then(setSettings, warn('Settings'))
    void call('window', 'state').then(setWindowState, warn('The window state'))
    // The same set the 'chats' event carries: archived chats too (their open pages are not drafts).
    void Promise.all([call('chats', 'list', { limit: 1000 }), call('chats', 'list', { status: 'archived', limit: 1000 })]).then(([live, archived]) => setChats((current) => current ?? [...live, ...archived]), (err: unknown) => {
      warn('Chats')(err)
      setChats((current) => current ?? [])
    })
    void Promise.all([call('companions', 'list'), call('companions', 'activeId')]).then(([list, activeId]) => setCompanions({ list, activeId }), warn('Companions'))
    void call('routines', 'list').then(setRoutines, warn('Routines'))
    void call('bookmarks', 'list').then(setBookmarks, warn('Bookmarks'))
    void call('downloads', 'list').then(setDownloads, warn('Downloads'))
    return () => offs.forEach((off) => off())
  }, [])

  // Apex's own Reduce Motion and the profile hue apply live (both are on <html> before the first render).
  useLayoutEffect(() => {
    applyMotionSetting(settings.reduceMotion)
    applyProfileHue(settings.profileHue)
  }, [settings.reduceMotion, settings.profileHue])

  const activeCompanion = companions.list.find((c) => c.id === companions.activeId) ?? null
  // ST-09: the chosen companion's Dock icon, drawn again on every launch and look change.
  useDockChoice(settings.dockIcon, companions.list)

  const realActiveTab = snapshot.tabs.find((t) => t.id === snapshot.activeId) ?? null
  // DS-99: a destination shows on its own surface over the content area. The
  // toolbar and pill read it as the current page ("Apex / ‹page›"); the tab
  // behind it stays as it was and comes back on Back, ⌘W or any tab or chat.
  const rail = snapshot.rail ?? null
  const activeTab: TabInfo | null = rail && realActiveTab
    ? { ...realActiveTab, url: rail.url, title: rail.title, crumbs: rail.crumbs, favicon: null, loading: false, canGoBack: true, canGoForward: false, agentControlled: false, agentChatId: null, needsInput: false, audible: false }
    : realActiveTab

  // ---- panel ----
  const openPanel = useCallback((chatId?: string | null) => {
    setPanelOpen(true)
    savePanelOpen(true)
    if (chatId) setPanelRequest(chatId)
  }, [])
  // DS-65: the tabs holding a chat beside their page (expanded from the panel); a closed tab or one that left its website lets go.
  const heldChats = useHeldChats()
  useEffect(() => pruneHeldChats(allTabs.tabs), [allTabs.tabs])
  const togglePanel = useCallback(() => {
    // DS-65: while this tab holds a chat beside its page, the toggle moves that chat back into the panel.
    const tabId = snapshot.activeId
    const heldHere = !panelOpen && tabId ? heldChat(tabId) : null
    if (tabId && heldHere) {
      void collapseToPanel(heldHere, tabId, openPanel)
      return
    }
    setPanelOpen((open) => {
      savePanelOpen(!open)
      return !open
    })
  }, [panelOpen, snapshot.activeId, openPanel])
  useEffect(() => {
    if (panelRequest) setPanelRequest(null)
  }, [panelRequest])
  // A voice command opens the side panel on the chat it went to.
  useVoicePanel(openPanel)

  // The companion that owns what you're looking at: the chat driving this tab, or the chat this page shows.
  const currentChatId = activeTab ? (activeTab.agentChatId ?? chatIdOfUrl(activeTab.url) ?? heldChats.get(activeTab.id) ?? null) : null
  const currentChat = currentChatId ? (chats?.find((c) => c.id === currentChatId) ?? null) : null
  const shownCompanion = (currentChat && companions.list.find((c) => c.id === currentChat.companionId)) || activeCompanion
  const panelCompanionId = shownCompanion?.id ?? companions.activeId

  const newChatBeside = useCallback(() => {
    void call('chats', 'create', { companionId: panelCompanionId || undefined }).then(
      (draft) => openPanel(draft.id),
      (err: unknown) => toast.show({ message: t('core.app.couldnTStartA', { value: errorText(err) }), tone: 'error' }),
    )
  }, [panelCompanionId, openPanel])

  // ---- find, per tab: main owns the state and the overlay find bar (SH-44) ----
  const openFind = useCallback(() => {
    const id = snapshot.activeId
    if (id) void call('find', 'open', id).catch(() => undefined)
  }, [snapshot.activeId])

  const remountPage = useCallback((tabId: string) => setRemount((r) => ({ ...r, [tabId]: (r[tabId] ?? 0) + 1 })), [])

  useEffect(
    () =>
      apex.onCommand((command) => {
        if (command === 'focus-omnibox') toolbar.current?.focusOmnibox()
        else if (command === 'toggle-agent') togglePanel()
        // The panel starts a fresh chat on this command itself; App only opens it.
        else if (command === 'new-chat') openPanel()
        else if (command === 'reload-page' && (snapshot.rail || snapshot.activeId)) remountPage(snapshot.rail ? 'rail' : (snapshot.activeId ?? ''))
      }),
    [togglePanel, openPanel, remountPage, snapshot.activeId, snapshot.rail],
  )

  const shell: ShellActions = useMemo(
    () => ({
      openPanel,
      togglePanel,
      newChatBeside,
      openCompanionCard: (companionId, section = null) => setCard({ companionId, section }),
      renameWindow: () => setRenaming(true),
      openFind,
      focusAddress: () => toolbar.current?.focusOmnibox(),
      remountPage,
    }),
    [openPanel, togglePanel, newChatBeside, openFind, remountPage],
  )

  // ---- layout ----
  const sidebarLayout = settings.layout === 'sidebar'
  const sidebarWidth = liveSidebarWidth ?? settings.sidebarWidth
  useEffect(() => setLiveSidebarWidth(null), [settings.sidebarWidth])
  const fits = sidebarFits(windowWidth, sidebarWidth, panelOpen ? settings.panelWidth : null)
  useEffect(() => {
    if (fits || !windowState.sidebarOpen) setForceSidebar(false)
  }, [fits, windowState.sidebarOpen])
  const sidebarShown = sidebarLayout && windowState.sidebarOpen && (fits || forceSidebar)
  const pageFullScreen = windowState.pageFullScreen
  const navRail = railShown(settings.layout, snapshot) && !pageFullScreen
  // Focus mode hides the sidebar, toolbar, bars and panel like a full-screen page does.
  const focusMode = windowState.focusMode === true
  const chromeless = pageFullScreen || focusMode
  const trafficRoom = isMac && !windowState.fullScreen
  const traffic = useTrafficLights(isMac && !chromeless && !windowState.fullScreen)

  const toggleSidebar = (): void => {
    if (windowState.sidebarOpen && !sidebarShown) setForceSidebar(true)
    else void call('window', 'setSidebarOpen', !windowState.sidebarOpen)
  }

  const counts = chatCounts(chats ?? [])
  const running = (chats ?? []).filter((c) => c.status === 'running')
  const agent = {
    working: currentChat ? currentChat.status === 'running' : running.length > 0,
    approvals: (chats ?? []).filter((c) => c.status === 'needs-approval').length,
  }

  const split = snapshot.split
  // The panel stays mounted while it closes, so its frame can fold away on the layout timeline.
  const panelState = useLayerPresence(panelOpen && !chromeless, MOTION.layout)
  // The page is an inset card beside a chat and in split view; flush in the sheet otherwise.
  const inset = !chromeless && (panelState === 'open' || split !== null)
  const panes: Array<{ slot: Slot; tabId: string }> = split
    ? [{ slot: 'primary', tabId: split.primaryId }, { slot: 'secondary', tabId: split.secondaryId }]
    : snapshot.activeId ? [{ slot: 'primary', tabId: snapshot.activeId }] : []
  // DS-84b: closing a split keeps the removed pane for one layout beat, wiping it away while the other widens.
  const splitPresence = useLayerPresence(split !== null, MOTION.layout)
  const lastSplitRatio = useRef(snapshot.splitRatio)
  if (split) lastSplitRatio.current = snapshot.splitRatio
  const unsplitting = !split && splitPresence === 'closing'

  const bookmarksBarShown = settings.bookmarksBar === 'always' || (settings.bookmarksBar === 'newtab' && activeTab !== null && isBlankUrl(activeTab.url))

  // Reports where each native view goes (and its corner radius) whenever the layout changes.
  const layoutReport = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    const measure = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height }
    }
    let lastKey = ''
    const report = (): void => {
      const primary = measure(slots.current.primary)
      if (!primary) return
      const pane = slots.current.primary?.parentElement
      const radius = pane ? Number.parseFloat(getComputedStyle(pane).borderTopLeftRadius) || 0 : 0
      const layout = { primary, secondary: split ? measure(slots.current.secondary) : null, peek: peek.open ? measure(peekFrame.current) : null, radius }
      // Frame-by-frame during transitions: skip frames where nothing moved.
      const key = JSON.stringify(layout)
      if (key === lastKey) return
      lastKey = key
      apex.layout.setLayout(layout)
    }
    layoutReport.current = report
    report()
    const observer = new ResizeObserver(report)
    for (const el of [slots.current.primary, slots.current.secondary, peekFrame.current]) if (el) observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
    // panes.length: the first tab can arrive after mount, and its slot must be observed then.
  }, [panes.length, panelState, bookmarksBarShown, split?.primaryId, split?.secondaryId, snapshot.splitRatio, peek.open, settings.layout, sidebarShown, sidebarWidth, chromeless, trafficRoom, inset, /* CH-03 */ settings.panelDock, navRail])

  // One layout timeline: the sidebar, the panel and the inset card animate in
  // CSS, and the native page views (and the window controls) follow them
  // frame by frame so nothing jumps or drifts. Reduce Motion: one report.
  useEffect(
    () =>
      followFrames(MOTION.layout + 80, () => {
        layoutReport.current()
        traffic.current()
      }),
    // A saved ratio change (the split menu's reset) eases the panes on the same timeline.
    [sidebarShown, panelState, inset, split?.primaryId, split?.secondaryId, snapshot.splitRatio, chromeless, traffic],
  )

  // Toasts stay inside the sidebar when it shows; otherwise they would cover a web page.
  const activeIsWeb = activeTab !== null && !isInternalUrl(activeTab.url) && !isBlankUrl(activeTab.url)
  useEffect(() => {
    const root = document.documentElement.style
    if (sidebarShown) {
      root.setProperty('--toast-inset-x', '10px')
      root.setProperty('--toast-max-width', `${sidebarWidth - 20}px`)
      root.setProperty('--toast-inset-bottom', '56px')
    } else {
      root.removeProperty('--toast-inset-x')
      root.removeProperty('--toast-max-width')
      root.removeProperty('--toast-inset-bottom')
    }
  }, [sidebarShown, sidebarWidth])

  // DS-74: a chat asked on the new tab takes over that tab as its chat page,
  // and the page's composer glides in from where the ask field was.
  const ask = (tabId: string, text: string, companionId: string): void => {
    void apex.agent.start(text, { companionId: companionId || undefined }).then(
      (chatId) => {
        const handoff = takeAskHandoff(tabId)
        const rectOf = (r: { left: number; top: number; width: number; height: number }): DOMRect => DOMRect.fromRect({ x: r.left, y: r.top, width: r.width, height: r.height })
        if (handoff) noteComposerOrigin(chatId, rectOf(handoff.rect))
        // DS-73: the figure that stood on the new tab flies into the first reply's face once the chat page shows it.
        if (handoff?.figure) noteStanding(chatId, rectOf(handoff.figure.rect), handoff.figure.image, 4000)
        void apex.nav.go(tabId, chatUrl(chatId))
      },
      (err: unknown) => toast.show({ message: t('core.app.couldnTStartThe', { value: errorText(err) }), tone: 'error' }),
    )
  }

  // The companion card: from the avatar, or an apex://companion/<id>/<section> tab.
  const activeRoute = activeTab ? parseInternalUrl(activeTab.url) : null
  const routeCard = activeRoute?.page === 'companion' && activeRoute.id ? { companionId: activeRoute.id, section: activeRoute.section, item: activeRoute.item } : null
  const shownCard = card ?? routeCard
  const closeCard = (): void => {
    if (card) {
      setCard(null)
      return
    }
    // DS-121: in an apex://companion tab, close closes the tab.
    if (activeTab && routeCard) void apex.tabs.close(activeTab.id)
  }

  const bookmarked = activeTab !== null && bookmarks.some((b) => b.url === activeTab.url)
  const menuDeps = { snapshot, settings, bookmarks, sidebarOpen: windowState.sidebarOpen, shell }

  const renderPane = (tab: TabInfo | undefined): ReactElement | null => {
    if (!tab) return null
    const key = `${tab.id}:${remount[tab.id] ?? 0}`
    if (isInternalUrl(tab.url)) {
      return (
        <ErrorBoundary key={key} what={t('core.app.thisPage')} resetKey={tab.url}>
          <InternalPage url={tab.url} tabId={tab.id} settings={settings} companion={activeCompanion ?? DEFAULT_PROFILE} isMac={isMac} onSettings={setSettings} />
        </ErrorBoundary>
      )
    }
    // SH-42: a blank split pane lists the tabs that aren't showing
    if (isBlankUrl(tab.url) && split && (split.primaryId === tab.id || split.secondaryId === tab.id)) {
      return (
        <ErrorBoundary key={key} what={t('core.app.theSplitChooser')}>
          <SplitChooser snapshot={snapshot} paneTabId={tab.id} />
        </ErrorBoundary>
      )
    }
    if (isBlankUrl(tab.url)) {
      return (
        <ErrorBoundary key={key} what={t('core.app.theNewTabPage')}>
          <NewTabPage tabId={tab.id} onAsk={(text, companionId) => ask(tab.id, text, companionId)} />
        </ErrorBoundary>
      )
    }
    // A failed or crashed page; main keeps the page view hidden while this shows.
    if (showsPageError(tab)) {
      return (
        <ErrorBoundary key={key} what={t('core.app.thisErrorPage')} compact>
          <PageErrorView tab={tab} searchEngine={settings.searchEngine} />
        </ErrorBoundary>
      )
    }
    // RD-02: the reader view; main keeps the page view hidden while it shows.
    if (tab.reader === 'open') {
      return (
        <ErrorBoundary key={`${key}:reader`} what={t('core.app.thisPage')} resetKey={tab.url}>
          <ReaderView tab={tab} />
        </ErrorBoundary>
      )
    }
    return null
  }

  return (
    <ShellContext.Provider value={shell}>
      <CompanionsContext.Provider value={companions}>
        {/* data-active-companion: the toolbar no longer names the companion (DS-24); tests read the switch here. */}
        <div className={cx('app', sidebarLayout ? 'app--sidebar' : 'app--horizontal', chromeless && 'app--page-fullscreen', focusMode && 'app--focus-mode', sidebarShown && 'app--sidebar-shown')} data-active-companion={companions.activeId || undefined}>
          {sidebarLayout && (
            <ErrorBoundary what={t('core.app.theSidebar')} compact>
              <Sidebar
                snapshot={snapshot}
                chats={chats}
                routines={routines}
                settings={settings}
                bookmarks={bookmarks}
                downloads={downloads}
                sidebarOpen={windowState.sidebarOpen}
                hidden={!sidebarShown || chromeless}
                width={sidebarWidth}
                resizing={liveSidebarWidth !== null}
                trafficLights={trafficRoom}
                onWidth={setLiveSidebarWidth}
                onWidthCommit={(sidebarWidth) => void apex.settings.set({ sidebarWidth })}
              />
            </ErrorBoundary>
          )}
          <div className="main">
            {!sidebarLayout && !chromeless && (
              <ErrorBoundary what={t('core.app.theTabStrip')} compact>
                <TabStrip snapshot={snapshot} settings={settings} bookmarks={bookmarks} chats={chats} trafficLights={trafficRoom} />
              </ErrorBoundary>
            )}
            <div className="sheet">
              {!chromeless && (
                <div className="sheet__bars">
                  <ErrorBoundary what={t('core.app.theToolbar')} compact>
                    <Toolbar
                      ref={toolbar}
                      tab={activeTab}
                      snapshot={snapshot}
                      sidebarToggle={sidebarLayout ? { open: sidebarShown, dot: counts.needsInput > 0 ? 'needs' : counts.unread > 0 ? 'unread' : null } : null}
                      bookmarked={bookmarked}
                      showFullUrls={settings.showFullUrls}
                      downloads={sidebarLayout ? null : downloads}
                      panelOpen={panelOpen}
                      agent={agent}
                      onToggleSidebar={toggleSidebar}
                      onTogglePanel={togglePanel}
                      menu={sidebarLayout ? null : menuDeps}
                    />
                  </ErrorBoundary>
                  {bookmarksBarShown && <BookmarksBar bookmarks={bookmarks} activeTabId={snapshot.activeId} />}
                </div>
              )}
              {/* data-card-region: the area the companion card washes and floats over. */}
              <div className={cx('workspace', inset && 'workspace--inset')} data-card-region>
                {/* SH-63: the navigation rail beside apex:// pages in the horizontal layout. */}
                {navRail && <NavRail snapshot={snapshot} chats={chats} routines={routines} settings={settings} bookmarks={bookmarks} />}
                <div className={cx('content', (split || unsplitting) && 'content--split', unsplitting && 'content--unsplitting')} style={split ? splitStyle(snapshot.splitRatio) : unsplitting ? splitStyle(lastSplitRatio.current) : undefined}>
                  {rail && (
                    <div className="pane pane--rail">
                      <ErrorBoundary key={`rail:${remount.rail ?? 0}`} what={t('core.app.thisPage')} resetKey={rail.url}>
                        <InternalPage url={rail.url} tabId={snapshot.activeId ?? ''} settings={settings} companion={activeCompanion ?? DEFAULT_PROFILE} isMac={isMac} onSettings={setSettings} />
                      </ErrorBoundary>
                    </div>
                  )}
                  {/* The seam sits in the gap between the panes (SH-41). */}
                  {split && !rail && <SplitSeam ratio={snapshot.splitRatio ?? 0.5} onLayout={() => layoutReport.current()} />}
                  {panes.map(({ slot, tabId }) => {
                    const tab = snapshot.tabs.find((t) => t.id === tabId)
                    return (
                      <div
                        key={slot}
                        className={cx('pane', split && tabId === snapshot.activeId && 'pane--focused-split', split && (slot === 'primary' ? 'pane--split-left' : 'pane--split-right'), unsplitting && 'pane--split-left', rail && 'pane--behind-rail')}
                        onMouseDown={() => {
                          if (tabId !== snapshot.activeId) void apex.tabs.activate(tabId)
                        }}
                      >
                        {/* DS-65: a website tab holding a chat shows the chat page with its page beside it. */}
                        <TabPaneBody key={tabId} tabId={tabId} chatId={heldChats.get(tabId) ?? null} slotRef={(el) => { slots.current[slot] = el }} onLayout={() => layoutReport.current()}>
                          {renderPane(tab)}
                        </TabPaneBody>
                      </div>
                    )
                  })}
                  {/* DS-84b: the closed split's pane, wiping away on the layout timeline. */}
                  {unsplitting && <div key="split-leaving" className="pane pane--split-right pane--split-leaving" aria-hidden="true" />}
                </div>
                {panelState !== 'closed' && (
                  <div className="panel-frame" data-state={panelState} data-dock={settings.panelDock /* CH-03: left docks it before the page */} inert={panelState === 'closing' || undefined} data-card-column>
                    <ErrorBoundary what={t('core.app.theCompanionPanel')} compact>
                      <AgentPanel
                        chatId={panelRequest}
                        companionId={panelCompanionId}
                        onExpand={(chatId) => void call('pages', 'open', chatUrl(chatId))}
                        onClose={() => {
                          setPanelOpen(false)
                          savePanelOpen(false)
                        }}
                      />
                    </ErrorBoundary>
                  </div>
                )}
              </div>
            </div>
          </div>
          {shownCard && !chromeless && (
            <ErrorBoundary what={t('core.app.theCompanionCard')} resetKey={shownCard.companionId}>
              <CompanionCard key={card ? 'card' : 'page'} companionId={shownCard.companionId} section={shownCard.section} item={shownCard.item ?? null} asPage={!card && routeCard !== null} onClose={closeCard} />
            </ErrorBoundary>
          )}
          <RenameWindowDialog open={renaming} current={windowState.name} onClose={() => setRenaming(false)} />
          <UiHost toastPlacement="bottom-left" toastsCoverPage={!sidebarShown && activeIsWeb} />
          {/* OV-20 to OV-22: opens the notice, shield and pill in the overlay host */}
          <AtWorkLayer
            panelOpen={panelOpen}
            activeTabId={snapshot.activeId}
            openPanel={openPanel}
            closePanel={() => {
              setPanelOpen(false)
              savePanelOpen(false)
            }}
          />
          {/* The updates, diagnostics and system layers; each renders nothing until it has something to show */}
          <UpdatesLayer />
          <DiagnosticsLayer />
          <SystemLayer />
        </div>
      </CompanionsContext.Provider>
    </ShellContext.Provider>
  )
}
