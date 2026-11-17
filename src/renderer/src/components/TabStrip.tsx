/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactElement, type WheelEvent } from 'react'
import type { ChatSummary } from '@shared/chats'
import type { OrderEntry, SettingsView, TabInfo, TabsSnapshot } from '@shared/ipc'
import type { Bookmark } from '@shared/services'
import type { TabGroup } from '@shared/tabs'
import { Camera, Mic, MonitorUp, Plus, Volume2, VolumeX, X } from 'lucide-react'
import { atelier, call } from '../api'
import { t } from '../i18n/useT'
import { Skeleton, StatusDot, cx, showContextMenu, useReducedMotion } from '../ui'
import { useShell } from './shellContext'
import { useDragSource, useDropZone, currentDrag, type TextDrop } from './sidebar/dnd'
import { useNumberHints, useTabDragActive } from './sidebar/events'
import { GroupRow } from './sidebar/GroupRow'
import { closeCard } from './sidebar/hoverCard'
import { groupedItems, visibleTabIds, type ListItem } from './sidebar/logic/groups'
import { backgroundMenu } from './sidebar/logic/menus'
import { manualMoveIndex, visibleOrder } from './sidebar/logic/order'
import { isSelected } from './sidebar/logic/selection'
import { stripDensity, stripScroll, stripTabWidth } from './sidebar/logic/strip'
import { NO_FINISHED, stepFinished, unreadTabIds } from './sidebar/logic/stripUnread'
import { NumberHints } from './sidebar/NumberHints'
import { runShellMenu, shellMenuContext } from './sidebar/shellMenu'
import { useRecentTabsSwitcher } from './sidebar/switcher'
import { activateTab, openTabMenu, runTextDrop } from './sidebar/tabActions'
import { cardEvents, cardFor } from './sidebar/TabsSection'
import { TabIcon } from './sidebar/util'

// The horizontal layout's tab strip (SH-21). Pinned tabs are icons at the
// leading edge; the other tabs shrink from about 200 to about 20 px and then
// the strip scrolls, keeping the active tab in view. Groups are chips in
// front of their tabs. Rows behave as in the sidebar: the same menus,
// selection, hover cards (below the tab), drops, tear-off and number hints.

/** The strip's hover card follows a little sooner than the sidebar's (SH-28). */
const STRIP_DWELL_MS = 300

interface TabStripProps {
  snapshot: TabsSnapshot
  settings: SettingsView
  bookmarks: Bookmark[]
  /** The chat list, for the unread mark (SH-21): a companion finished here, or a chat page with unread results. */
  chats?: readonly ChatSummary[] | null
  /** macOS window controls sit at the strip's leading edge. */
  trafficLights: boolean
}

interface StripTabProps {
  tab: TabInfo
  props: TabStripProps
  order: readonly string[]
  gapBefore: boolean
  group: TabGroup | null
  dropTarget: boolean
  dragActive: boolean
  unread: boolean
  onGroupCreated(group: TabGroup): void
}

/** What the tab is capturing, in words: its marks' label and part of the tab's own. */
function captureLabels(tab: TabInfo): string[] {
  const { camera, microphone, screen } = tab.capture
  return [camera && t('tabs.strip.camera'), microphone && t('tabs.strip.microphone'), screen && t('tabs.strip.screen')].filter((s): s is string => !!s)
}

function CaptureMarks({ tab }: { tab: TabInfo }): ReactElement | null {
  const { camera, microphone, screen } = tab.capture
  if (!camera && !microphone && !screen) return null
  return (
    <span className="tab__capture" role="img" aria-label={captureLabels(tab).join(', ')}>
      {camera && <Camera size={12} aria-hidden />}
      {microphone && <Mic size={12} aria-hidden />}
      {screen && <MonitorUp size={12} aria-hidden />}
    </span>
  )
}

function StripTab({ tab, props, order, gapBefore, group, dropTarget, dragActive, unread, onGroupCreated }: StripTabProps): ReactElement {
  const { snapshot, bookmarks } = props
  const drag = useDragSource({ kind: 'tab', id: tab.id })
  const active = tab.id === snapshot.activeId
  const selected = isSelected(snapshot.selection ?? [], tab.id)
  const inSplit = snapshot.split !== null && (snapshot.split.primaryId === tab.id || snapshot.split.secondaryId === tab.id)
  const title = tab.title || t('tabs.card.newTab')
  const card = cardEvents(`strip:${tab.id}`, () => cardFor(tab), !dragActive, { side: 'below', dwellMs: STRIP_DWELL_MS })
  const status = [
    ...captureLabels(tab),
    tab.audible && !tab.muted && t('tabs.strip.audio'),
    tab.muted && t('tabs.strip.muted'),
    tab.needsInput && t('tabs.strip.attention'),
    tab.agentControlled && t('tabs.strip.agent'),
    unread && t('tabs.strip.unread'),
    inSplit && t('tabs.strip.split'),
    tab.sleeping && t('tabs.strip.sleeping'),
  ].filter(Boolean)
  return (
    <div
      {...drag}
      {...card}
      {...(group ? { 'data-group-color': group.color } : {})}
      role="tab"
      aria-selected={active || selected}
      aria-label={[title, ...status].join(', ')}
      aria-busy={tab.restoring || tab.loading || undefined}
      tabIndex={active ? 0 : -1}
      data-drop-row
      data-drop-id={tab.id}
      data-tab-ids={tab.id}
      className={cx(
        'tab',
        active && 'tab--active',
        selected && !active && 'tab--selected',
        tab.pinned && 'tab--pinned',
        tab.agentControlled && 'tab--agent',
        inSplit && 'tab--split',
        group && 'tab--grouped',
        tab.sleeping && 'tab--sleeping',
        gapBefore && 'tab--gap-before',
        tab.needsInput && 'tab--attention',
        unread && 'tab--unread',
        dropTarget && 'tab--drop-target',
      )}
      onClick={(e) => activateTab(tab, snapshot, e, order)}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button === 1) void atelier.tabs.close(tab.id)
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          activateTab(tab, snapshot, e, order)
        }
      }}
      onContextMenu={(e) => void openTabMenu(e, { tab, snapshot, shown: snapshot.tabs, bookmarks, onGroupCreated })}
    >
      <span className="tab__icon">{tab.restoring ? <Skeleton width={16} height={16} radius={4} /> : <TabIcon tab={tab} />}</span>
      {!tab.pinned && (tab.restoring ? <Skeleton className="tab__title" width="60%" height={10} radius={5} /> : <span className="tab__title">{title}</span>)}
      <CaptureMarks tab={tab} />
      {tab.needsInput && <StatusDot status="needs-input" size={7} label={t('tabs.strip.attention')} pulse={false} />}
      {unread && !tab.needsInput && <StatusDot status="unread" size={7} label={t('tabs.strip.unread')} pulse={false} />}
      {(tab.audible || tab.muted) && (
        <button
          type="button"
          className="tab__audio"
          tabIndex={-1}
          aria-label={tab.muted ? t('tabs.tabStrip.unmuteSite') : t('tabs.tabStrip.muteSite')}
          title={tab.muted ? t('tabs.tabStrip.unmuteSite') : t('tabs.tabStrip.muteSite')}
          onClick={(e) => {
            e.stopPropagation()
            void call('tabs', 'setMuted', tab.id, !tab.muted)
          }}
        >
          {tab.muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
        </button>
      )}
      {!tab.pinned && (
        <button
          type="button"
          className="tab__close"
          tabIndex={-1}
          aria-label={t('tabs.tabStrip.close', { title })}
          title={t('tabs.tabStrip.closeTabW')}
          onClick={(e) => {
            e.stopPropagation()
            void atelier.tabs.close(tab.id)
          }}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </div>
  )
}

export function TabStrip(props: TabStripProps): ReactElement {
  const { snapshot, settings, bookmarks, trafficLights } = props
  const shell = useShell()
  const strip = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const dragActive = useTabDragActive()
  const hintsShown = useNumberHints()
  const [available, setAvailable] = useState(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  useRecentTabsSwitcher(snapshot, true)
  // SH-21: the unread mark, from the same signals as the sidebar's rows.
  const chats = props.chats ?? null
  const [finishedState, setFinishedState] = useState(NO_FINISHED)
  useEffect(() => setFinishedState((prev) => stepFinished(prev, snapshot.tabs, snapshot.activeId, chats)), [snapshot.tabs, snapshot.activeId, chats])
  const unread = useMemo(() => unreadTabIds(snapshot.tabs, snapshot.activeId, chats, finishedState.finished), [snapshot.tabs, snapshot.activeId, chats, finishedState])

  const tabById = useMemo(() => new Map(snapshot.tabs.map((tab) => [tab.id, tab])), [snapshot.tabs])
  const pinned = snapshot.tabs.filter((tab) => tab.pinned)
  const rest = snapshot.tabs.filter((tab) => !tab.pinned)
  const items: ListItem[] = groupedItems(
    rest.map((tab) => ({ kind: 'tab' as const, tab })),
    snapshot.groups ?? [],
    (id) => tabById.get(id)?.groupId ?? null,
  )
  const shownIds = [...pinned.map((tab) => tab.id), ...visibleTabIds(items)]
  const groups = new Map((snapshot.groups ?? []).map((g) => [g.id, g]))
  const chips = items.filter((i) => i.kind === 'group').length
  const width = stripTabWidth({ available, tabs: shownIds.length - pinned.length, pinned: pinned.length, chips: chips * 84 })
  const density = stripDensity(width)

  // The tab area's width sets every tab's width.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = (): void => setAvailable(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const order = snapshot.tabs.map((tab) => tab.id)
  const dropText = (drop: TextDrop): void => runTextDrop(drop, settings.searchEngine, shownIds)
  const drop = useDropZone(
    'tabs',
    (entry, index) => {
      const tab = tabById.get(entry.id)
      if (!tab) return
      // Dropping among pinned icons pins; among the rest unpins.
      const others = shownIds.filter((id) => id !== tab.id)
      const landsPinned = tabById.get(others[index] ?? '')?.pinned ?? (index < pinned.length && tab.pinned)
      const target = manualMoveIndex(order, tab.id, shownIds, index)
      void (async () => {
        if (tab.pinned !== landsPinned) await call('tabs', 'setPinned', tab.id, landsPinned)
        await call('tabs', 'move', tab.id, target)
      })()
    },
    'grid',
    dropText,
  )

  // The strip's order is what you see; report it so ⌘1–8 match (tabs of collapsed groups are skipped).
  const entries = useMemo<OrderEntry[]>(() => {
    const shown = new Set(shownIds)
    return visibleOrder([], [], snapshot.tabs.filter((tab) => shown.has(tab.id)))
  }, [snapshot.tabs, shownIds.join(',')])
  const orderKey = JSON.stringify(entries)
  useEffect(() => {
    void call('tabs', 'setOrder', JSON.parse(orderKey))
  }, [orderKey])

  // Hover cards close on a tab switch or a drag.
  useEffect(() => closeCard(), [snapshot.activeId, dragActive])

  // Keep the active tab in view: jump when it is far, glide when it is near.
  useEffect(() => {
    const el = scroller.current
    const id = snapshot.activeId
    if (!el || !id) return
    const tab = el.querySelector<HTMLElement>(`[data-tab-ids="${CSS.escape(id)}"]`)
    if (!tab) return
    const plan = stripScroll({ left: tab.offsetLeft, width: tab.offsetWidth }, { scrollLeft: el.scrollLeft, width: el.clientWidth }, reduced)
    if (plan) el.scrollTo({ left: plan.left, behavior: plan.behavior })
  }, [snapshot.activeId, snapshot.tabs.length, width, reduced])

  const onBackground = (e: MouseEvent): void => {
    if (e.target instanceof Element && e.target.closest('.tab, .strip-group, button')) return
    const deps = { snapshot, settings, bookmarks, sidebarOpen: false, shell }
    void showContextMenu(e, backgroundMenu(shellMenuContext(deps))).then((id) => {
      if (id) runShellMenu(id, deps)
    })
  }

  // A vertical wheel scrolls the strip sideways.
  const onWheel = (e: WheelEvent): void => {
    const el = scroller.current
    if (el && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY
  }

  const dragId = currentDrag()?.id ?? null
  let visual = 0
  const tabEl = (tab: TabInfo, group: TabGroup | null): ReactElement => {
    const dragging = tab.id === dragId
    const gapBefore = !dragging && drop.gap === visual
    if (!dragging) visual++
    return (
      <StripTab
        key={tab.id}
        tab={tab}
        props={props}
        order={shownIds}
        gapBefore={gapBefore}
        group={group}
        dropTarget={drop.textTarget === tab.id}
        dragActive={dragActive}
        unread={unread.has(tab.id)}
        onGroupCreated={(g) => setRenaming(g.id)}
      />
    )
  }
  return (
    <div
      ref={strip}
      className={cx('tabstrip', trafficLights && 'tabstrip--inset', `tabstrip--${density}`)}
      style={{ '--strip-tab-w': `${width}px` } as CSSProperties}
      onContextMenu={onBackground}
      onDoubleClick={(e) => e.preventDefault()}
    >
      {trafficLights && <div className="traffic-slot" data-traffic-slot="" />}
      <div ref={scroller} className="tabstrip__tabs" role="tablist" aria-label={t('tabs.strip.label')} aria-multiselectable data-tear-list onWheel={onWheel} onScroll={closeCard} {...drop.props}>
        {pinned.map((tab) => tabEl(tab, null))}
        {items.map((item) => {
          if (item.kind === 'group') {
            return <GroupRow key={`group:${item.group.id}`} variant="chip" group={item.group} tabIds={item.tabIds} tabs={snapshot.tabs} renaming={renaming === item.group.id} focusable={false} onRename={(on) => setRenaming(on ? item.group.id : null)} />
          }
          if (item.kind !== 'tab') return null
          return tabEl(item.tab, item.groupId ? (groups.get(item.groupId) ?? null) : null)
        })}
        <button type="button" className="tabstrip__new" aria-label={t('tabs.strip.newTab')} title={t('tabs.tabStrip.t', { value: t('tabs.strip.newTab') })} onClick={() => void atelier.tabs.create(undefined, { position: 'end' }).then(shell.focusAddress)}>
          <Plus size={16} aria-hidden />
        </button>
      </div>
      <NumberHints shown={hintsShown} entries={entries} root={strip} />
    </div>
  )
}
