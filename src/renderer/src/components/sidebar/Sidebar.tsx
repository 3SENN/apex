/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import type { ChatSummary } from '@shared/chats'
import { chatListRows } from './logic/chatRows' // DS-72b
import { SIDEBAR_WIDTH, type OrderEntry, type SettingsView, type TabInfo, type TabsSnapshot } from '@shared/ipc'
import type { Bookmark, DownloadInfo, Routine } from '@shared/services'
import { DESTINATIONS, parseInternalUrl, type Destination } from '@shared/url'
import { ArrowDown, ArrowUp, LayoutList, Search } from 'lucide-react'
import { openUniversalSearch } from '../AddressPill'
import { atelier, call, errorText } from '../../api'
import { IconButton, Seam, cx, showContextMenu, toast, useFlip, useLayerPresence, useReducedMotion, MOTION } from '../../ui'
import { useCompanions, useShell } from '../shellContext'
import { ChatsSection, startNewChatPage } from './ChatsSection'
import { chatTabs } from './chatActions'
import { Destinations, type Arrival } from './Destinations'
import { SpaceRow } from './SpaceRow'
import type { DragEntry, TextDrop } from './dnd'
import { DownloadsButton } from './DownloadsButton'
import { useNumberHints, useTabDragActive } from './events'
import { closeCard } from './hoverCard'
import { useOpenChats, usePointerHold, usePointerInside, useScrollCues, useStableIds } from './hooks'
import { chatMarks, detectArrival, edgeCueLabel, type ChatMark } from './logic/cues'
import { groupedItems, visibleTabIds } from './logic/groups'
import { backgroundMenu, chatCounts } from './logic/menus'
import { chatIdOfUrl, manualMoveIndex, sortChats, sortTabs, tabRows, visibleOrder, type Placement, type TabRowItem } from './logic/order'
import { NO_FINISHED, stepFinished } from './logic/stripUnread'
import { NowPlayingCard } from '../media/NowPlayingCard' // media hub (MD-01): SH-17's card with artwork, next and previous
import { NumberHints } from './NumberHints'
import { useEdgeReveal, useOptionsSurface } from './reveal'
import { runShellMenu, shellMenuContext } from './shellMenu'
import { SidebarFooter } from './SidebarFooter'
import { SidebarOptionsPanel } from './SidebarOptions'
import { useRecentTabsSwitcher } from './switcher'
import { runTextDrop } from './tabActions'
import { NewTabRow, PinnedGrid, TabsSection, listItemKey } from './TabsSection'
import './sidebar.css'
import { useT } from '../../i18n/useT'
import { SidebarApps } from '../../apps/SidebarApps'

/** How long the All chats arrival sequence plays (sidebar.css keeps the same length). */
const ARRIVAL_MS = 1500

interface SidebarProps {
  snapshot: TabsSnapshot
  /** null until the first chat list arrives. */
  chats: ChatSummary[] | null
  routines: Routine[]
  settings: SettingsView
  bookmarks: Bookmark[]
  /** The header's downloads button shows while there are any. */
  downloads: DownloadInfo[]
  /** The saved open state (the menus show it). */
  sidebarOpen: boolean
  /** Collapsed or hidden for a narrow window. It stays mounted so its state and the tab order survive, and slides away on the layout timeline. */
  hidden: boolean
  width: number
  /** The seam is being dragged: the width follows the pointer without easing. */
  resizing: boolean
  /** macOS window controls sit in the header. */
  trafficLights: boolean
  onWidth(width: number): void
  onWidthCommit(width: number): void
  /** Drawn in the overlay by the edge reveal (SH-04): no seam, no window-wide listeners. */
  floating?: boolean
}


/** Tabs whose chat finished while you were elsewhere; cleared when you look. The strip (SH-21) steps the same state. */
function useFinishedTabs(tabs: readonly TabInfo[], activeId: string | null, chats: readonly ChatSummary[] | null): ReadonlySet<string> {
  const [state, setState] = useState(NO_FINISHED)
  useEffect(() => setState((prev) => stepFinished(prev, tabs, activeId, chats)), [tabs, activeId, chats])
  return state.finished
}

/** The All chats arrival cue: set when a chat arrives in the background, cleared once the sequence has played. */
function useArrival(chats: readonly ChatSummary[] | null, visibleChatIds: ReadonlySet<string>): Arrival | null {
  const marks = useRef<Map<string, ChatMark> | null>(null)
  const [arrival, setArrival] = useState<Arrival | null>(null)
  const visible = useRef(visibleChatIds)
  visible.current = visibleChatIds
  useEffect(() => {
    if (!chats) return
    const arrived = detectArrival(marks.current, chats, visible.current)
    marks.current = chatMarks(chats)
    if (arrived) setArrival((a) => ({ companionId: arrived.companionId, key: (a?.key ?? 0) + 1 }))
  }, [chats])
  useEffect(() => {
    if (!arrival) return
    const timer = setTimeout(() => setArrival((a) => (a?.key === arrival.key ? null : a)), ARRIVAL_MS)
    return () => clearTimeout(timer)
  }, [arrival])
  return arrival
}

/**
 * The sidebar layout's left column, the ground: a header on the toolbar's
 * line (window controls, downloads, options, search), a fixed block that
 * never scrolls (the pinned grid, New Tab, the destinations), then chats and
 * tabs as one scrolling list, empty drag space and the profile footer. It
 * reports its visible order for ⌘1–9.
 */
export function Sidebar(props: SidebarProps): ReactElement {
  const t = useT()
  const { snapshot: tabsSnapshot, chats, routines, settings, bookmarks, hidden, width } = props
  // DS-99: while a destination shows on its own surface, no tab or chat row is active.
  const rail = tabsSnapshot.rail ?? null
  const snapshot = useMemo(() => (rail ? { ...tabsSnapshot, activeId: null, split: null } : tabsSnapshot), [tabsSnapshot, rail])
  const options = settings.sidebar
  const shell = useShell()
  const { activeId: activeCompanionId } = useCompanions()
  const root = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const held = usePointerHold(root)
  const pointerIn = usePointerInside(root)
  const reduced = useReducedMotion()
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  // SH-09: the options popover is drawn in the overlay; the inline panel is only the fallback without one.
  const [overlayOptions, setOverlayOptions] = useState(true)
  const floating = props.floating === true
  const dragActive = useTabDragActive()
  const hintsShown = useNumberHints()
  const optionsSurface = useOptionsSurface(options, () => setOptionsOpen(false))
  // The switcher and the edge reveal belong to the window's own sidebar, never to the floating copy.
  useRecentTabsSwitcher(tabsSnapshot, !floating)
  useEdgeReveal(!floating && hidden)
  // Hover cards close on a tab switch and when a tab drag starts (SH-28).
  useEffect(() => closeCard(), [tabsSnapshot.activeId, dragActive])
  const optionsState = useLayerPresence(optionsOpen, MOTION.menuOut)
  const [placements, setPlacements] = useState<Record<string, Placement>>({})
  // The universal search palette replaced the old inline filter, so rows are never filtered here.
  const filtering = false
  const chatsShown = options.sections === 'tabs-and-chats'

  // The destination row with the chip comes from the window-level surface, never from a tab.
  const railRoute = rail ? parseInternalUrl(rail.url) : null
  const currentDest = railRoute && (DESTINATIONS as readonly string[]).includes(railRoute.page) ? (railRoute.page as Destination) : null

  // ---- chats ----
  const chatById = useMemo(() => new Map((chats ?? []).map((c) => [c.id, c])), [chats])
  const chatTabIds = useMemo(() => [...new Set(snapshot.tabs.map((t) => chatIdOfUrl(t.url)).filter((id): id is string => id !== null))], [snapshot.tabs])
  const openChats = useOpenChats(chats, chatTabIds)
  const sortedChats = useMemo(() => {
    const known = openChats.order.map((id) => chatById.get(id)).filter((c): c is ChatSummary => c !== undefined && !c.archived)
    return sortChats(known, options.chatSort, options.sections, openChats.order)
  }, [openChats.order, chatById, options.chatSort, options.sections])
  const stableChatIds = useStableIds(sortedChats.map((c) => c.id), held && options.chatSort !== 'manual')
  // DS-72b: nothing joins Chats until its first send; an empty chat page shows under Your tabs meanwhile.
  const allChatRows = chatListRows(stableChatIds, chatById)
  const chatRows = allChatRows
  const listedChatIds = new Set(chatsShown ? allChatRows.map((c) => c.id) : [])
  const activeChatIds = new Set(
    [snapshot.activeId, snapshot.split?.primaryId, snapshot.split?.secondaryId]
      .map((id) => snapshot.tabs.find((t) => t.id === id))
      .map((t) => (t ? chatIdOfUrl(t.url) : null))
      .filter((id): id is string => id !== null),
  )
  const counts = chatCounts(chats ?? [])
  const routineUnread = (chats ?? []).some((c) => c.routineId !== null && c.unread)

  // ---- tabs ----
  const pinned = snapshot.tabs.filter((t) => t.pinned)
  const listTabs = snapshot.tabs.filter((t) => !t.pinned && !(listedChatIds.has(chatIdOfUrl(t.url) ?? '')))
  const sortedTabs = sortTabs(listTabs, options.tabSort, placements)
  const stableTabIds = useStableIds(sortedTabs.map((t) => t.id), held && options.tabSort === 'recent')
  const tabById = new Map(snapshot.tabs.map((t) => [t.id, t]))
  const orderedTabs = stableTabIds.map((id) => tabById.get(id)).filter((t): t is TabInfo => t !== undefined)
  const rows: TabRowItem[] = tabRows(orderedTabs, snapshot.split)
  const groupOf = (id: string): string | null => tabById.get(id)?.groupId ?? null
  // Groups (SH-23): a header row in front of its tabs, which are left out while collapsed.
  const items = groupedItems(rows, snapshot.groups ?? [], groupOf)
  const shownPinned = pinned
  const shownTabs = [...shownPinned, ...orderedTabs]
  const rowIds = items.flatMap((i) => (i.kind === 'group' ? [] : [i.kind === 'tab' ? i.tab.id : i.primary.id]))
  const selectOrder = [...shownPinned.map((t) => t.id), ...visibleTabIds(items)]

  // Placements expire once their tab is used again or closed.
  useEffect(() => {
    setPlacements((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([id, p]) => (tabById.get(id)?.lastActiveAt ?? Infinity) <= p.at))
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [snapshot.tabs])

  // ---- the order ⌘1–8 follow ----
  const visibleChatCount = !chatsShown || options.chatsCollapsed ? 0 : Math.min(allChatRows.length, options.chatRows ?? allChatRows.length)
  const unhidden = new Set(visibleTabIds(groupedItems(tabRows(orderedTabs, snapshot.split), snapshot.groups ?? [], groupOf)))
  const orderKey = JSON.stringify(visibleOrder(pinned, allChatRows.slice(0, visibleChatCount).map((c) => c.id), orderedTabs.filter((t) => unhidden.has(t.id))))
  const orderEntries = useMemo(() => JSON.parse(orderKey) as OrderEntry[], [orderKey])
  useEffect(() => {
    // The floating copy shows the same order; only the window's own sidebar reports it.
    if (!floating) void call('tabs', 'setOrder', JSON.parse(orderKey))
  }, [orderKey, floating])

  const finished = useFinishedTabs(snapshot.tabs, snapshot.activeId, chats)
  const arrival = useArrival(chats, activeChatIds)

  // ---- the one scrolling list ----
  const listKey = [...chatRows.map((c) => `${c.id}:${c.status}:${c.needsInput}`), ...items.map(listItemKey), snapshot.activeId ?? ''].join(',')
  const cues = useScrollCues(scroller, `${listKey}|${options.chatsCollapsed}`)
  useFlip(scroller, listKey)
  // Activating a tab brings its row into view.
  useEffect(() => {
    const id = snapshot.activeId
    if (!id) return
    const row = scroller.current?.querySelector<HTMLElement>(`[data-tab-ids~="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [snapshot.activeId, reduced])
  const jump = (edge: 'above' | 'below'): void => {
    const el = scroller.current
    const cue = cues[edge]
    if (!el || !cue) return
    const view = el.getBoundingClientRect()
    const candidates = Array.from(el.querySelectorAll<HTMLElement>(`[data-cue="${cue}"]`)).filter((row) => {
      const r = row.getBoundingClientRect()
      return edge === 'above' ? r.bottom <= view.top + 4 : r.top >= view.bottom - 4
    })
    const target = edge === 'above' ? candidates.at(-1) : candidates[0]
    target?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
  }

  // ---- actions ----
  const closeChats = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        for (const tabId of chatTabs(snapshot, id)) void atelier.tabs.close(tabId)
        openChats.close(id, chatById.get(id)?.lastActiveAt ?? 0)
      }
    },
    [snapshot, openChats, chatById],
  )

  // The Chats header's Clear: the chats leave the sidebar (they stay in All Chats); Undo puts them back in their order.
  const clearChats = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return
      const set = new Set(ids)
      const before = openChats.order.filter((id) => set.has(id))
      closeChats(ids)
      toast.show({
        message: ids.length === 1 ? t('tabs.clear.chatsClearedOne') : t('tabs.clear.chatsCleared', { count: ids.length }),
        undo: () => openChats.restore(before.length ? before : ids),
      })
    },
    [closeChats, openChats],
  )

  const order = snapshot.tabs.map((t) => t.id)
  const dropPinned = (entry: DragEntry, index: number): void => {
    const tab = tabById.get(entry.id)
    if (!tab) return
    const target = manualMoveIndex(order, tab.id, pinned.map((t) => t.id), index)
    void (async () => {
      if (!tab.pinned) await call('tabs', 'setPinned', tab.id, true)
      await call('tabs', 'move', tab.id, target)
    })().catch((err: unknown) => toast.show({ message: t('tabs.sidebar.couldnTMoveThe', { value: errorText(err) }), tone: 'error' }))
  }
  const dropText = (drop: TextDrop): void => runTextDrop(drop, settings.searchEngine, rowIds)
  const dropList = (entry: DragEntry, index: number): void => {
    const tab = tabById.get(entry.id)
    if (!tab) return
    void (async () => {
      if (tab.pinned) await call('tabs', 'setPinned', tab.id, false)
      if (options.tabSort === 'manual') await call('tabs', 'move', tab.id, manualMoveIndex(order, tab.id, rowIds, index))
      else {
        // Activity order has no fixed positions: remember where you put it until it is used again.
        const others = rowIds.filter((id) => id !== tab.id)
        setPlacements((p) => ({ ...p, [tab.id]: { after: index > 0 ? (others[index - 1] ?? null) : null, at: Date.now() } }))
      }
    })().catch((err: unknown) => toast.show({ message: t('tabs.sidebar.couldnTMoveThe', { value: errorText(err) }), tone: 'error' }))
  }

  const reorderChat = (id: string, index: number): void => {
    const others = openChats.order.filter((x) => x !== id)
    const before = chatRows.filter((c) => c.id !== id)[index]
    // Drafts sit above the manual order, so landing before one means the top.
    openChats.reorder(id, before ? Math.max(0, others.indexOf(before.id)) : others.length)
  }

  const openOptions = (): void => {
    setOptionsOpen(true)
    const anchor = root.current?.querySelector('[data-sidebar-options-toggle]')
    if (!anchor || floating) return setOverlayOptions(false)
    void optionsSurface.open(anchor).then((overlay) => {
      if (!overlay) setOverlayOptions(false)
    })
  }
  const closeOptions = (): void => {
    optionsSurface.close()
    setOptionsOpen(false)
  }


  const onBackgroundMenu = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('[data-sidebar-row], button, input, .side-options, .ui-seam, a, .side-footer')) return
    const deps = { snapshot, settings, bookmarks, sidebarOpen: props.sidebarOpen, shell }
    void showContextMenu(e, backgroundMenu(shellMenuContext(deps))).then((id) => {
      if (id) runShellMenu(id, deps)
    })
  }

  // Arrow keys move between rows; the active row (or the first) takes Tab.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    if (!(e.target instanceof HTMLElement) || !e.target.matches('[data-sidebar-row]')) return
    // Leaving rows and a collapsed section are inert: skip them.
    const all = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-sidebar-row]') ?? []).filter((el) => !el.closest('[inert]'))
    const i = all.indexOf(e.target)
    const inGrid = e.target.classList.contains('pin-tile')
    let next = i
    if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = all.length - 1
    else if (e.key === 'ArrowDown') next = i + 1
    else if (e.key === 'ArrowUp') next = i - 1
    else if (inGrid) next = e.key === 'ArrowRight' ? i + 1 : i - 1
    else return
    e.preventDefault()
    all[Math.max(0, Math.min(all.length - 1, next))]?.focus()
  }
  const activeChat = chatRows.find((c) => activeChatIds.has(c.id))
  const activeTab = snapshot.tabs.find((t) => t.id === snapshot.activeId) ?? null
  const focusId = activeTab && (activeTab.pinned || rows.some((r) => (r.kind === 'tab' ? r.tab.id : r.primary.id) === activeTab.id))
    ? activeTab.id
    : (activeChat?.id ?? (currentDest ? `dest:${currentDest}` : 'new-tab'))

  const companionOfChat = (chatId: string): string | null => chatById.get(chatId)?.companionId ?? null

  return (
    <div className={cx('sidebar-frame', hidden && 'sidebar-frame--hidden', props.resizing && 'sidebar-frame--resizing')} style={{ width: hidden ? 0 : width }}>
      <aside
        ref={root}
        className="sidebar"
        style={{ width }}
        aria-label={t('tabs.sidebar.sidebar')}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
        data-pointer-in={pointerIn || undefined}
        onContextMenu={onBackgroundMenu}
        onKeyDown={onKeyDown}
      >
        <div className="side-header">
          {/* Always marked: the window controls follow the slot as the sidebar slides, and hide once it is away. */}
          {props.trafficLights && <div className="traffic-slot" data-traffic-slot="" />}
          <span className="side-header__drag" />
          <DownloadsButton downloads={props.downloads} />
          <IconButton
            label={t('tabs.sidebar.sidebarOptions')}
            icon={<LayoutList />}
            pressed={optionsOpen}
            data-sidebar-options-toggle=""
            onClick={() => (optionsOpen ? closeOptions() : openOptions())}
          />
          {/* The centred palette replaces the old inline filter */}
          <IconButton label={t('tabs.sidebar.searchTabsAndChats')} shortcut="CmdOrCtrl+Shift+A" icon={<Search />} onClick={() => openUniversalSearch()} />
        </div>
        {optionsState !== 'closed' && !overlayOptions && <SidebarOptionsPanel options={options} closing={optionsState === 'closing'} onClose={() => setOptionsOpen(false)} />}

        <div className="side-body">
          <div className="side-fixed">
            {/* At the top, hidden until a project exists */}
            <SpaceRow />
            <PinnedGrid
              pinned={shownPinned}
              snapshot={snapshot}
              bookmarks={bookmarks}
              shownTabs={shownTabs}
              order={selectOrder}
              dragActive={dragActive}
              onGroupCreated={(group) => setRenamingGroup(group.id)}
              draggable={!filtering}
              focusId={focusId}
              onDrop={dropPinned}
            />
            <NewTabRow focusable={focusId === 'new-tab'} />
            <Destinations
              options={options}
              current={currentDest}
              activeTabId={rail ? 'rail' : snapshot.activeId}
              unread={counts.unread}
              needsInput={counts.needsInput}
              routines={routines}
              routineUnread={routineUnread}
              arrival={arrival}
              focusId={focusId}
              onOpenOptions={openOptions}
              onReset={shell.remountPage}
            />
            {/* AP-01: the apps you keep at hand, as icons and rows; nothing until you (or a pack) put one here. */}
            <SidebarApps pins={options.apps ?? []} />
          </div>
          <div className={cx('side-scroll', cues.top && 'side-scroll--fade-top', cues.bottom && 'side-scroll--fade-bottom', !cues.top && !cues.bottom && 'side-scroll--still')}>
            <span className={cx('side-scroll__rule', cues.top && 'side-scroll__rule--shown')} aria-hidden />
            {cues.above && (
              <button type="button" className={cx('edge-badge edge-badge--top', cues.above === 'needs' && 'edge-badge--needs')} onClick={() => jump('above')}>
                <ArrowUp size={11} aria-hidden />
                {edgeCueLabel(cues.above)}
              </button>
            )}
            <div ref={scroller} className="side-scroll__list" onScroll={closeCard}>
              {chatsShown && (
                <ChatsSection
                  chats={chatRows}
                  snapshot={snapshot}
                  activeChatIds={activeChatIds}
                  collapsed={options.chatsCollapsed && !filtering}
                  rows={options.chatRows}
                  showLastUsed={options.showLastUsed}
                  manual={options.chatSort === 'manual'}
                  filtering={filtering}
                  focusId={focusId}
                  onToggleCollapsed={() => void atelier.settings.set({ sidebar: { chatsCollapsed: !options.chatsCollapsed } })}
                  onNewChat={() => void startNewChatPage(snapshot, activeCompanionId)}
                  onSearch={() => openUniversalSearch('chats')}
                  onClose={closeChats}
                  onClear={clearChats}
                  onReorder={reorderChat}
                  onRows={(chatRows) => void atelier.settings.set({ sidebar: { chatRows } })}
                />
              )}
              <TabsSection
                items={items}
                snapshot={snapshot}
                bookmarks={bookmarks}
                shownTabs={shownTabs}
                order={selectOrder}
                dragActive={dragActive}
                renamingGroup={renamingGroup}
                onRenameGroup={setRenamingGroup}
                onText={dropText}
                finished={finished}
                companionOfChat={companionOfChat}
                labelShown={chatsShown}
                showLastUsed={options.showLastUsed}
                draggable={!filtering}
                filtering={filtering}
                pinnedCount={pinned.length}
                focusId={focusId}
                onDrop={dropList}
              />
              {/* Empty space under the list moves the window, like the header. */}
              <div className="side-scroll__drag" aria-hidden />
            </div>
            {cues.below && (
              <button type="button" className={cx('edge-badge edge-badge--bottom', cues.below === 'needs' && 'edge-badge--needs')} onClick={() => jump('below')}>
                <ArrowDown size={11} aria-hidden />
                {edgeCueLabel(cues.below)}
              </button>
            )}
          </div>
        </div>

        {/* SH-17, MD-01: the newest source that isn't showing (the media hub picks it), with a way to all of them. */}
        {settings.mediaCard !== false && <NowPlayingCard />}

        <SidebarFooter deps={{ snapshot, settings, bookmarks, sidebarOpen: props.sidebarOpen }} />

        {!floating && <NumberHints shown={hintsShown && !hidden} entries={orderEntries} root={root} />}

        {!floating && <Seam
          className="sidebar__seam ui-seam--bare"
          label={t('tabs.sidebar.resizeSidebar')}
          value={width}
          min={SIDEBAR_WIDTH.min}
          max={SIDEBAR_WIDTH.max}
          resetTo={SIDEBAR_WIDTH.default}
          valueText={(v) => t('tabs.sidebar.pixelsWide', { value: Math.round(v) })}
          onChange={props.onWidth}
          onCommit={props.onWidthCommit}
        />}
      </aside>
    </div>
  )
}
