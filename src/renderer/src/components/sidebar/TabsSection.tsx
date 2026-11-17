/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement } from 'react'
import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import type { Bookmark } from '@shared/services'
import type { TabGroup } from '@shared/tabs'
import { ArrowDownToLine, Plus, Unlink2, Volume2, VolumeX, X } from 'lucide-react'
import { atelier, call } from '../../api'
import { t } from '../../i18n/useT'
import { tabFace } from './logic/tabFace' // DS-67
import { MOTION, RelativeTime, Skeleton, StatusDot, cx, usePresenceList, type PresencePhase } from '../../ui'
import { useCompanionById, useShell } from '../shellContext'
import { chatCard, splitCard, tabCard } from './cardContent'
import { CompanionAvatarById } from './CompanionAvatar'
import { currentDrag, useDragSource, useDropZone, type DragEntry, type TextDrop } from './dnd'
import { GroupRow } from './GroupRow'
import { closeCard, hoverRow, leaveRow, type CardContent } from './hoverCard'
import { leadId, type ListItem } from './logic/groups'
import { chatIdOfUrl, pinnedColumns, type TabRowItem } from './logic/order'
import { isSelected } from './logic/selection'
import { activateTab, clearTabs, openSplitRowMenu, openTabMenu } from './tabActions'
import { TabIcon, agentColorVars, cssVars } from './util'

interface RowHandlers {
  snapshot: TabsSnapshot
  bookmarks: readonly Bookmark[]
  /** Pinned then listed tabs, as shown (the tab menu's "close below"). */
  shownTabs: TabInfo[]
  /** Tab ids in the order shown, without tabs of collapsed groups (⇧-click ranges). */
  order?: readonly string[]
  /** A tab drag is under way somewhere: rows show no hover cards. */
  dragActive?: boolean
  /** A group made from the tab menu starts renaming. */
  onGroupCreated?(group: TabGroup): void
}

/** A tab's hover card: a chat tab shows the chat's preview, any other its page. */
export function cardFor(tab: TabInfo): Promise<CardContent> {
  const chatId = chatIdOfUrl(tab.url)
  return chatId ? chatCard({ id: chatId, title: tab.title }) : tabCard(tab)
}

/** Hover-card handlers for a row (DS-92): the card follows after the dwell and leaves with the pointer. */
export function cardEvents(key: string, build: () => Promise<CardContent | null>, enabled: boolean, more: { side?: 'right' | 'below'; dwellMs?: number; onChoose?(value: unknown): void } = {}) {
  return {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (enabled && e.pointerType !== 'touch') hoverRow(e.currentTarget, { key, side: more.side ?? 'right', dwellMs: more.dwellMs, build, onChoose: more.onChoose })
    },
    onPointerLeave: () => leaveRow(key),
    onPointerDown: () => closeCard(),
  }
}

/** The faint rows a restored tab shows until its page reports its favicon and title (SS-01). */
export function RestoringRow(): ReactElement {
  return (
    <>
      <span className="side-row__icon">
        <Skeleton width={16} height={16} radius={4} />
      </span>
      <span className="side-row__title side-row__title--restoring" aria-label={t('tabs.restoring')}>
        <Skeleton width="62%" height={10} radius={5} />
      </span>
    </>
  )
}

function AudioButton({ tab }: { tab: TabInfo }): ReactElement | null {
  if (!tab.audible && !tab.muted) return null
  return (
    <button
      type="button"
      className={cx('side-row__audio', tab.muted && 'side-row__audio--muted')}
      aria-label={tab.muted ? t('tabs.sidebarTabs.unmuteSite') : t('tabs.sidebarTabs.muteSite')}
      title={tab.muted ? t('tabs.sidebarTabs.unmuteSite') : t('tabs.sidebarTabs.muteSite')}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation()
        void call('tabs', 'setMuted', tab.id, !tab.muted)
      }}
    >
      {tab.muted ? <VolumeX size={13} aria-hidden /> : <Volume2 size={13} aria-hidden />}
    </button>
  )
}

function TabBadges({ tab, finished, companionOfChat }: { tab: TabInfo; finished: boolean; companionOfChat(id: string): string | null }): ReactElement {
  // DS-67: one frameless head with its state mark beside it (working, waiting for you, done).
  const face = tabFace(tab, finished)
  const label = face ? t(face.state === 'waiting' ? 'tabs.edgeCue.needs' : face.state === 'working' ? 'tabs.row.working' : 'tabs.row.done') : ''
  return (
    <span className="side-row__badges">
      <AudioButton tab={tab} />
      {face && (
        <span className={`side-row__agent side-row__agent--${face.state}`} title={label}>
          <CompanionAvatarById id={face.chatId ? companionOfChat(face.chatId) : null} size={16} mood={face.mood} mark={face.mark} label={label} />
        </span>
      )}
    </span>
  )
}

function rowKeys(tab: TabInfo, { snapshot, order }: RowHandlers) {
  return (e: KeyboardEvent) => {
    // Enter or Space activates; with ⇧ they take a range from the active tab (SH-25).
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      activateTab(tab, snapshot, e, order)
    }
  }
}

function rowEvents(tab: TabInfo, { snapshot, bookmarks, shownTabs, order, onGroupCreated }: RowHandlers, { menu = true }: { menu?: boolean } = {}) {
  return {
    onClick: (e: MouseEvent) => activateTab(tab, snapshot, e, order),
    onMouseDown: (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault()
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      void atelier.tabs.close(tab.id)
    },
    onContextMenu: menu ? (e: MouseEvent) => void openTabMenu(e, { tab, snapshot, shown: shownTabs, bookmarks, onGroupCreated }) : undefined,
  }
}

/**
 * The trailing slot: no width at rest. While the pointer is in the sidebar
 * it shows the last-used stamp; hovering or focusing the row swaps that for
 * close (the active row too, only then).
 */
export function TrailingSlot({ lastUsed, closeLabel, closeTitle, onClose }: { lastUsed: number | null; closeLabel: string; closeTitle: string; onClose(): void }): ReactElement {
  return (
    <span className="side-row__trail">
      {lastUsed !== null && <RelativeTime value={lastUsed} style="short" className="side-row__time" />}
      <button
        type="button"
        className="side-row__close"
        aria-label={closeLabel}
        title={closeTitle}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <X size={13} aria-hidden />
      </button>
    </span>
  )
}

function PinnedTile({ tab, active, handlers, gapBefore, dragging, draggable, focusable }: { tab: TabInfo; active: boolean; handlers: RowHandlers; gapBefore: boolean; dragging: boolean; draggable: boolean; focusable: boolean }): ReactElement {
  const drag = useDragSource({ kind: 'tab', id: tab.id }, draggable)
  const events = rowEvents(tab, handlers)
  const selected = isSelected(handlers.snapshot.selection ?? [], tab.id)
  const card = cardEvents(`pin:${tab.id}`, () => cardFor(tab), !handlers.dragActive)
  return (
    <div
      {...drag}
      {...events}
      {...card}
      role="option"
      aria-selected={active || selected}
      aria-label={tab.title || t('tabs.sidebarTabs.newTab')}
      tabIndex={focusable ? 0 : -1}
      title={tab.title || t('tabs.sidebarTabs.newTab')}
      data-sidebar-row
      data-drop-row
      data-drop-id={tab.id}
      data-tab-ids={tab.id}
      data-flip={`pin:${tab.id}`}
      className={cx('pin-tile', active && 'pin-tile--active', selected && 'pin-tile--selected', tab.needsInput && 'pin-tile--attention', tab.agentControlled && 'pin-tile--agent', gapBefore && 'pin-tile--gap-before', dragging && 'pin-tile--dragging')}
      onKeyDown={rowKeys(tab, handlers)}
    >
      {tab.restoring ? <Skeleton width={18} height={18} radius={5} /> : <TabIcon tab={tab} size={18} />}
      {(tab.audible || tab.muted) && (
        <span className="pin-tile__audio" aria-hidden>
          {tab.muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
        </span>
      )}
      {tab.needsInput && <StatusDot status="needs-input" size={7} className="pin-tile__dot" label="" pulse={false} />}
      <button
        type="button"
        className="pin-tile__close"
        aria-label={t('tabs.sidebarTabs.unpin', { value: tab.title || 'tab' })}
        title={t('tabs.sidebarTabs.unpin2')}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          void call('tabs', 'setPinned', tab.id, false)
        }}
      >
        <X size={10} aria-hidden />
      </button>
    </div>
  )
}

interface PinnedGridProps extends RowHandlers {
  pinned: TabInfo[]
  draggable: boolean
  focusId: string | null
  onDrop(entry: DragEntry, index: number): void
}

/** The pinned tiles, at the very top of the fixed header (only when tabs are pinned, or while a tab is dragged). */
export function PinnedGrid({ pinned, snapshot, bookmarks, shownTabs, order, dragActive, onGroupCreated, draggable, focusId, onDrop }: PinnedGridProps): ReactElement | null {
  const handlers: RowHandlers = { snapshot, bookmarks, shownTabs, order, dragActive, onGroupCreated }
  const drop = useDropZone('pinned', onDrop, 'grid')
  const dragId = currentDrag()?.id ?? null
  if (pinned.length === 0 && dragId === null) return null
  const isActive = (id: string): boolean => snapshot.activeId === id || (snapshot.split !== null && (snapshot.split.primaryId === id || snapshot.split.secondaryId === id))
  let visual = 0
  return (
    <div
      className={cx('pin-grid', pinned.length === 0 && 'pin-grid--empty', drop.gap !== null && 'pin-grid--over')}
      role="listbox"
      aria-label={t('tabs.sidebarTabs.pinnedTabs')}
      aria-orientation="horizontal"
      aria-multiselectable
      data-tear-list
      style={cssVars({ '--pin-columns': Math.max(1, pinnedColumns(pinned.length)) })}
      {...drop.props}
    >
      {pinned.length === 0 && <span className="pin-grid__hint">{t('tabs.sidebarTabs.dropHereToPin')}</span>}
      {pinned.map((tab) => {
        const dragging = tab.id === dragId
        const gapBefore = !dragging && drop.gap === visual
        if (!dragging) visual++
        return <PinnedTile key={tab.id} tab={tab} active={isActive(tab.id)} handlers={handlers} gapBefore={gapBefore} dragging={dragging} draggable={draggable} focusable={focusId === tab.id} />
      })}
    </div>
  )
}

/** New Tab: the only top row in the strong tone. */
export function NewTabRow({ focusable }: { focusable: boolean }): ReactElement {
  const shell = useShell()
  return (
    <button
      type="button"
      className="side-row new-tab-row"
      data-sidebar-row
      tabIndex={focusable ? 0 : -1}
      onClick={() => void atelier.tabs.create(undefined, { position: 'top' }).then(shell.focusAddress)}
      title={t('tabs.sidebarTabs.newTabT')}
    >
      <span className="side-row__icon">
        <Plus size={16} aria-hidden />
      </span>
      <span className="side-row__title">{t('tabs.sidebarTabs.newTab')}</span>
    </button>
  )
}

interface TabRowProps {
  item: TabRowItem
  active: boolean
  phase: PresencePhase
  props: TabsSectionProps
  handlers: RowHandlers
  gapBefore: boolean
  dragging: boolean
  focusable: boolean
  /** The colour of the group the row is in, if any. */
  group: TabGroup | null
  /** A drop of text would load in this row. */
  dropTarget: boolean
}

function TabRow({ item, active, phase, props, handlers, gapBefore, dragging, focusable, group, dropTarget }: TabRowProps): ReactElement {
  const lead = item.kind === 'tab' ? item.tab : item.primary
  const leaving = phase === 'exit'
  // Split rows drag as a pair: main moves the lead tab and the split follows it.
  const drag = useDragSource({ kind: 'tab', id: lead.id }, props.draggable && !leaving)
  const agentCompanion = useCompanionById(lead.agentChatId ? props.companionOfChat(lead.agentChatId) : null)
  const motion = { 'data-flip': `tab:${lead.id}`, 'data-phase': phase, inert: leaving || undefined }
  const selection = handlers.snapshot.selection ?? []
  const groupProps = group ? { 'data-group-color': group.color } : {}
  const cardsOn = !handlers.dragActive && !leaving
  if (item.kind === 'split') {
    const halves = [item.primary, item.secondary]
    const selected = halves.some((tab) => isSelected(selection, tab.id))
    const card = cardEvents(`split:${lead.id}`, () => splitCard(item.primary, item.secondary), cardsOn)
    return (
      <div
        {...drag}
        {...motion}
        {...card}
        {...groupProps}
        role="option"
        aria-selected={active || selected}
        aria-label={t('tabs.sidebarTabs.splitViewPair', { first: item.primary.title || t('tabs.sidebarTabs.newTab'), second: item.secondary.title || t('tabs.sidebarTabs.newTab') })}
        tabIndex={focusable ? 0 : -1}
        data-sidebar-row
        data-drop-row
        data-drop-id={lead.id}
        data-tab-ids={`${item.primary.id} ${item.secondary.id}`}
        data-cue={active ? 'active' : halves.some((t) => t.needsInput) ? 'needs' : undefined}
        className={cx('side-row tab-row tab-row--split', active && 'side-row--active', selected && !active && 'side-row--selected', group && 'tab-row--grouped', gapBefore && 'side-row--gap-before', dragging && 'side-row--dragging', dropTarget && 'side-row--drop-target')}
        // One menu for the pair, with a submenu per page (SH-19).
        onContextMenu={(e) => void openSplitRowMenu(e, item.primary, item.secondary, { snapshot: handlers.snapshot, shown: handlers.shownTabs, bookmarks: handlers.bookmarks, onGroupCreated: handlers.onGroupCreated })}
        onKeyDown={rowKeys(item.primary, handlers)}
      >
        {halves.map((tab, i) => (
          <span key={tab.id} className={cx('tab-row__half', handlers.snapshot.activeId === tab.id && 'tab-row__half--focused')} title={tab.title} {...rowEvents(tab, handlers, { menu: false })}>
            {i === 1 && <span className="tab-row__divider" aria-hidden />}
            {tab.restoring ? (
              <RestoringRow />
            ) : (
              <>
                <span className="side-row__icon">
                  <TabIcon tab={tab} />
                </span>
                <span className="side-row__title">{tab.title || t('tabs.sidebarTabs.newTab')}</span>
              </>
            )}
            <TabBadges tab={tab} finished={props.finished.has(tab.id)} companionOfChat={props.companionOfChat} />
          </span>
        ))}
        <button
          type="button"
          className="side-row__close side-row__close--split"
          aria-label={t('tabs.sidebarTabs.separateSplitView')}
          title={t('tabs.sidebarTabs.separateIntoTwoTabs')}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            void call('split', 'separate').catch(() => call('split', 'close'))
          }}
        >
          <Unlink2 size={13} aria-hidden />
        </button>
      </div>
    )
  }
  const tab = item.tab
  const selected = isSelected(selection, tab.id)
  const card = cardEvents(`tab:${tab.id}`, () => cardFor(tab), cardsOn)
  return (
    <div
      {...drag}
      {...rowEvents(tab, handlers)}
      {...motion}
      {...card}
      {...groupProps}
      role="option"
      aria-selected={active || selected}
      aria-busy={tab.restoring || undefined}
      tabIndex={focusable ? 0 : -1}
      title={tab.title || tab.url}
      data-sidebar-row
      data-drop-row
      data-drop-id={tab.id}
      data-tab-ids={tab.id}
      data-cue={active ? 'active' : tab.needsInput ? 'needs' : undefined}
      className={cx(
        'side-row tab-row',
        active && 'side-row--active',
        selected && !active && 'side-row--selected',
        group && 'tab-row--grouped',
        tab.sleeping && 'tab-row--sleeping',
        tab.agentControlled && 'tab-row--agent',
        gapBefore && 'side-row--gap-before',
        dragging && 'side-row--dragging',
        dropTarget && 'side-row--drop-target',
      )}
      style={agentColorVars(agentCompanion)}
      onKeyDown={rowKeys(tab, handlers)}
    >
      {tab.restoring ? (
        <RestoringRow />
      ) : (
        <>
          <span className="side-row__icon">
            <TabIcon tab={tab} />
          </span>
          <span className="side-row__title">{tab.title || t('tabs.sidebarTabs.newTab')}</span>
        </>
      )}
      <TabBadges tab={tab} finished={props.finished.has(tab.id)} companionOfChat={props.companionOfChat} />
      <TrailingSlot lastUsed={props.showLastUsed ? tab.lastActiveAt : null} closeLabel={t('tabs.sidebarTabs.close', { value: tab.title || 'tab' })} closeTitle="Close tab (⌘W)" onClose={() => void atelier.tabs.close(tab.id)} />
    </div>
  )
}

export interface TabsSectionProps {
  /** The rows with group headers in front of their tabs; tabs of collapsed groups are left out. */
  items: ListItem[]
  snapshot: TabsSnapshot
  bookmarks: readonly Bookmark[]
  shownTabs: TabInfo[]
  /** Tab ids in the order shown (pinned first), for ⇧-click ranges. */
  order: readonly string[]
  /** Tabs whose chat finished since you last looked at them. */
  finished: ReadonlySet<string>
  /** The companion of the chat controlling a tab. */
  companionOfChat(chatId: string): string | null
  /** The plain "Your tabs" label shows whenever the chats section does. */
  labelShown: boolean
  showLastUsed: boolean
  draggable: boolean
  filtering: boolean
  /** Nothing is pinned and there are no other tabs either. */
  pinnedCount: number
  focusId: string | null
  /** A tab drag is under way: no hover cards. */
  dragActive: boolean
  /** The group whose header is being renamed. */
  renamingGroup: string | null
  onRenameGroup(id: string | null): void
  onDrop(entry: DragEntry, index: number): void
  /** Text or a link dropped onto a row or between rows. */
  onText(drop: TextDrop): void
}

export function listItemKey(item: ListItem): string {
  if (item.kind === 'group') return `group:${item.group.id}`
  return item.kind === 'tab' ? item.tab.id : `split:${item.primary.id}`
}

/** @deprecated The list keys groups too; kept for callers that only have tab rows. */
export function tabRowKey(item: TabRowItem): string {
  return item.kind === 'tab' ? item.tab.id : `split:${item.primary.id}`
}

/** The tab list, part of the sidebar's one scrolling list (under the chats). */
export function TabsSection(props: TabsSectionProps): ReactElement {
  const { items, snapshot, filtering, focusId } = props
  const handlers: RowHandlers = {
    snapshot,
    bookmarks: props.bookmarks,
    shownTabs: props.shownTabs,
    order: props.order,
    dragActive: props.dragActive,
    onGroupCreated: (group) => props.onRenameGroup(group.id),
  }
  const drop = useDropZone('tabs', props.onDrop, 'y', props.onText)
  const dragId = currentDrag()?.id ?? null
  const entries = usePresenceList(items, listItemKey, { exitMs: MOTION.quick })
  const groups = new Map((snapshot.groups ?? []).map((g) => [g.id, g]))
  const isActive = (id: string): boolean => snapshot.activeId === id || (snapshot.split !== null && (snapshot.split.primaryId === id || snapshot.split.secondaryId === id))
  const rowCount = items.filter((i) => i.kind !== 'group').length
  // Clear closes every unpinned tab in the window (Undo in the toast), so it shows while there is one.
  const clearable = snapshot.tabs.some((tab) => !tab.pinned)
  let visual = 0
  return (
    <section className={cx('side-section tabs-section', drop.gap !== null && 'side-section--drop')} aria-label={t('tabs.sidebarTabs.tabs')}>
      {(props.labelShown || clearable) && (
        <div className="side-section__header">
          <span className="side-label" id="side-tabs-label">
            {t('tabs.sidebarTabs.yourTabs')}
          </span>
          {clearable && !filtering && (
            <span className="side-section__actions">
              <button type="button" className="side-clear" title={t('tabs.clear.tabsTitle')} onClick={() => void clearTabs()}>
                <ArrowDownToLine size={12} aria-hidden />
                {t('tabs.clear.label')}
              </button>
            </span>
          )}
        </div>
      )}
      <div className="side-list" role="listbox" aria-label={t('tabs.sidebarTabs.openTabs')} aria-multiselectable data-tear-list {...drop.props}>
        {rowCount === 0 && items.length === 0 && <div className="side-empty">{filtering ? t('tabs.sidebarTabs.noTabsMatch') : props.pinnedCount ? t('tabs.sidebarTabs.everyTabIsPinned') : t('tabs.sidebarTabs.noOtherTabs')}</div>}
        {entries.map(({ key, item, phase }) => {
          if (item.kind === 'group') {
            return (
              <GroupRow
                key={key}
                group={item.group}
                tabIds={item.tabIds}
                tabs={snapshot.tabs}
                renaming={props.renamingGroup === item.group.id}
                focusable={focusId === `group:${item.group.id}`}
                onRename={(on) => props.onRenameGroup(on ? item.group.id : null)}
              />
            )
          }
          const lead = leadId(item)
          const dragging = lead === dragId
          const counted = !dragging && phase !== 'exit'
          const gapBefore = counted && drop.gap === visual
          if (counted) visual++
          const active = phase !== 'exit' && (item.kind === 'tab' ? isActive(item.tab.id) : isActive(item.primary.id) || isActive(item.secondary.id))
          const group = item.groupId ? (groups.get(item.groupId) ?? null) : null
          return (
            <TabRow
              key={key}
              item={item}
              phase={phase}
              active={active}
              props={props}
              handlers={handlers}
              gapBefore={gapBefore}
              dragging={dragging}
              focusable={focusId === lead}
              group={group}
              dropTarget={drop.textTarget === lead}
            />
          )
        })}
        {drop.gap !== null && drop.gap >= visual && <div className="side-list__end-gap" aria-hidden />}
      </div>
    </section>
  )
}
