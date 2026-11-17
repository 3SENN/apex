/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import type { ChatSummary } from '@shared/chats'
import { CHAT_ROWS_DEFAULT, type TabsSnapshot } from '@shared/ipc'
import { ArrowDownToLine, ChevronDown, Plus, Search } from 'lucide-react'
import { t } from '../../i18n/useT'
import { call, errorText } from '../../api'
import { useChatFace } from '../../companion'
import { IconButton, InlineRename, MOTION, Seam, StatusDot, cx, showContextMenu, showMenu, toast, usePresenceList, type PresencePhase } from '../../ui'
import { CompanionAvatarById } from './CompanionAvatar'
import { openChatPage, runChatMenu } from './chatActions'
import { useDragSource, useDropZone, currentDrag } from './dnd'
import { headerDots, needsYou } from './logic/cues'
import { chatMenu } from './logic/menus'
import { isSelected, menuTargets, rangeSelection } from './logic/selection'
import { TrailingSlot, cardEvents } from './TabsSection'
import { chatCard } from './cardContent'

/** Row pitch in px (32 px rows, 2 px apart); the divider counts rows in these steps. */
export const CHAT_ROW_HEIGHT = 34

interface ChatsSectionProps {
  /** Shown chats, sorted; saved chats only (DS-72b: an empty chat joins after its first send). */
  chats: ChatSummary[]
  snapshot: TabsSnapshot
  /** Chats the visible pane(s) show; their rows are highlighted. */
  activeChatIds: ReadonlySet<string>
  collapsed: boolean
  /** Rows above the divider; null shows all. */
  rows: number | null
  showLastUsed: boolean
  /** Rows drag to reorder (manual sort). */
  manual: boolean
  filtering: boolean
  onToggleCollapsed(): void
  onNewChat(): void
  onSearch(): void
  onClose(ids: string[]): void
  /** The header's Clear: these chats leave the sidebar (they stay in All Chats), with Undo. */
  onClear(ids: string[]): void
  /** `index` counts the shown rows without the dragged one. */
  onReorder(id: string, index: number): void
  onRows(rows: number | null): void
  /** Roving focus: the row that takes Tab. */
  focusId: string | null
}

/**
 * The chat's companion, face only, with the chat's state as its own small
 * mark beside the head, in the row's flow (DS-67): working, needs you,
 * unread, done, error, or the routine glyph for a routine run. Nothing is
 * drawn on the head; with no state the mark's space collapses. A chat that
 * starts waiting for you makes the head bounce once.
 */
function ChatAvatar({ chat }: { chat: ChatSummary }): ReactElement {
  const face = useChatFace(chat)
  const routine = chat.routineId !== null && chat.status !== 'running' && face.mark === null
  const waiting = needsYou(chat)
  return (
    <span className={cx('side-row__icon chat-row__avatar', waiting && 'chat-row__avatar--attention')}>
      <CompanionAvatarById id={chat.companionId} size={20} label={routine ? t('tabs.sidebarChats.startedByARoutine') : ''} chat={chat} mark={routine ? 'routine' : undefined} />
    </span>
  )
}

interface ChatRowProps {
  chat: ChatSummary
  phase: PresencePhase
  active: boolean
  editing: boolean
  showLastUsed: boolean
  draggable: boolean
  gapBefore: boolean
  dragging: boolean
  focusable: boolean
  onEditing(editing: boolean): void
  onOpen(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void
  /** Part of a ⇧-click selection of several chats (SH-18): the menu acts on all of them. */
  selected?: boolean
  onClose(): void
  onMenu(event: MouseEvent): void
}

function ChatRow({ chat, phase, active, editing, showLastUsed, draggable, gapBefore, dragging, focusable, onEditing, onOpen, onClose, onMenu, selected = false }: ChatRowProps): ReactElement {
  const leaving = phase === 'exit'
  const drag = useDragSource({ kind: 'chat', id: chat.id }, draggable && !editing && !leaving)
  const title = chat.title || t('tabs.sidebarChats.newChat')
  // DS-92: the chat's latest request, reply and progress after the dwell.
  const card = cardEvents(`chat:${chat.id}`, () => chatCard(chat), !leaving && !editing && !chat.draft)
  return (
    <div
      {...drag}
      {...card}
      role="option"
      tabIndex={focusable ? 0 : -1}
      data-sidebar-row
      data-drop-row
      data-drop-id={chat.id}
      data-flip={`chat:${chat.id}`}
      data-phase={phase}
      data-cue={active ? 'active' : needsYou(chat) ? 'needs' : undefined}
      inert={leaving || undefined}
      aria-selected={active || selected}
      className={cx('side-row chat-row', active && 'side-row--active', selected && !active && 'side-row--selected', gapBefore && 'side-row--gap-before', dragging && 'side-row--dragging', chat.unread && 'chat-row--unread')}
      title={title}
      onClick={(e) => onOpen(e)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onMouseDown={(e) => {
        // Keep middle-click from starting autoscroll.
        if (e.button === 1) e.preventDefault()
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(e)
        } else if (e.key === 'F2') {
          e.preventDefault()
          onEditing(true)
        }
      }}
      onContextMenu={onMenu}
    >
      <ChatAvatar chat={chat} />
      <span className="side-row__title">
        <InlineRename
          value={chat.title}
          placeholder={t('tabs.sidebarChats.newChat')}
          label={t('tabs.sidebarChats.chatTitle')}
          activation="none"
          editing={editing}
          onEditingChange={onEditing}
          maxLength={120}
          onCommit={async (next) => {
            try {
              await call('chats', 'rename', chat.id, next)
            } catch (err) {
              toast.show({ message: t('tabs.sidebarChats.couldnTRename', { value: errorText(err) }), tone: 'error' })
              throw err
            }
          }}
        />
      </span>
      <TrailingSlot lastUsed={showLastUsed && !chat.draft ? chat.lastActiveAt : null} closeLabel={t('tabs.sidebarChats.close', { title })} closeTitle={t('tabs.sidebarChats.closeChat2')} onClose={onClose} />
    </div>
  )
}

/** The small status dots a header shows at rest (and the collapsed toggle). */
export function HeaderDots({ needs, unread }: { needs: boolean; unread: boolean }): ReactElement | null {
  if (!needs && !unread) return null
  return (
    <span className="side-section__dots">
      {needs && <StatusDot status="needs-input" size={6} label={t('tabs.sidebarChats.aChatIsWaiting')} pulse={false} />}
      {unread && <StatusDot status="unread" size={6} label={t('tabs.sidebarChats.unreadResults')} pulse={false} />}
    </span>
  )
}

/**
 * Open chats as tab-like rows, part of the sidebar's one scrolling list,
 * with a divider that sets how many show. The label collapses the section
 * (it stays mounted so the height can ease shut); search, options and new
 * chat fade in on hover or focus, the status dots show at rest. The full
 * history lives in All chats.
 */
export function ChatsSection(props: ChatsSectionProps): ReactElement {
  const { chats, snapshot, activeChatIds, collapsed, rows, showLastUsed, manual, filtering, focusId } = props
  const [editing, setEditing] = useState<string | null>(null)
  // ⇧-click (and ⇧Enter, ⇧Space) selects a range of chats from the last one opened; the menu then acts on all of them (SH-18).
  const [selected, setSelected] = useState<string[]>([])
  const anchor = useRef<string | null>(null)
  const total = chats.length
  // Clear and Delete take every chat here but pinned ones and unsent drafts, as Clear on tabs leaves pinned tabs.
  const clearable = chats.filter((c) => !c.pinned && !c.draft)
  const [liveRows, setLiveRows] = useState<number | null>(null)
  useEffect(() => setLiveRows(null), [rows])
  // While filtering, every match shows.
  const limit = filtering ? total : Math.min(total, Math.max(1, liveRows ?? rows ?? total))
  const shown = chats.slice(0, limit)
  const hidden = chats.slice(limit)
  const hiddenDots = headerDots(hidden)
  const dots = headerDots(chats)
  const entries = usePresenceList(shown, (c) => c.id, { exitMs: MOTION.quick })
  // The index counts shown rows without the dragged one; the sidebar maps it to the manual order.
  const drop = useDropZone('chats', (entry, index) => props.onReorder(entry.id, index))
  const dragId = currentDrag()?.id ?? null

  const openMenu = async (event: MouseEvent, chat: ChatSummary): Promise<void> => {
    if (chat.draft) {
      const id = await showContextMenu(event, [{ id: 'close', label: t('tabs.sidebarChats.closeChat') }])
      if (id === 'close') props.onClose([chat.id])
      return
    }
    const ids = menuTargets(selected, chat.id)
    const targets = ids.map((x) => chats.find((c) => c.id === x)).filter((c): c is ChatSummary => c !== undefined && !c.draft)
    const id = await showContextMenu(event, chatMenu(targets, { inSidebar: true }))
    if (id) await runChatMenu(id, targets, { snapshot, rename: setEditing, close: props.onClose })
    if (id) setSelected([])
  }

  const openRow = (chat: ChatSummary, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): void => {
    if (e.shiftKey) {
      const from = anchor.current ?? chats.find((c) => activeChatIds.has(c.id))?.id ?? null
      setSelected(rangeSelection(shown.map((c) => c.id), from, chat.id))
      return
    }
    setSelected([])
    anchor.current = chat.id
    openChatPage(snapshot, chat.id, { newTab: e.metaKey || e.ctrlKey, background: e.metaKey || e.ctrlKey })
  }

  const sectionMenu = async (anchor: HTMLElement): Promise<void> => {
    const unread = chats.some((c) => c.unread)
    const n = clearable.length
    const id = await showMenu(
      [
        { id: 'mark-all-read', label: t('tabs.sidebarChats.markAllAsRead'), enabled: unread },
        { id: 'all-chats', label: t('tabs.sidebarChats.showAllChats'), accelerator: 'CmdOrCtrl+Shift+L' },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'clear', label: n === 1 ? t('tabs.clear.clearChat') : t('tabs.clear.clearChats', { count: n }), enabled: n > 0 },
        { id: 'delete-all', label: n === 1 ? t('tabs.sidebarMenus.delete2') : t('tabs.sidebarMenus.deleteChats', { count: n }), enabled: n > 0, danger: true },
      ],
      anchor,
    )
    if (id === 'mark-all-read') void call('chats', 'markAllRead')
    else if (id === 'all-chats') void call('pages', 'open', 'apex://chats')
    else if (id === 'clear') props.onClear(clearable.map((c) => c.id))
    // Deleting asks first, as deleting from a row's menu does: it can't be undone.
    else if (id === 'delete-all') await runChatMenu('delete', clearable, { snapshot, rename: setEditing, close: props.onClose })
  }

  let visual = 0
  return (
    <section className={cx('side-section chats-section', collapsed && 'side-section--collapsed', drop.gap !== null && 'side-section--drop')} aria-label={t('tabs.sidebarChats.chats')}>
      {/* DS-12: the section's options (mark all read, all chats, clear, delete) live on the header's context menu; Clear also shows on hover. */}
      <div
        className="side-section__header"
        onContextMenu={(e) => {
          e.preventDefault()
          void sectionMenu(e.currentTarget)
        }}
      >
        <button type="button" className="side-label side-label--toggle" aria-expanded={!collapsed} onClick={props.onToggleCollapsed}>
          <span>{t('tabs.sidebarChats.chats')}</span>
          <ChevronDown size={12} className="side-section__chevron" aria-hidden />
        </button>
        <span className="side-section__spacer" />
        <HeaderDots needs={dots.needs} unread={dots.unread} />
        {/* DS-12: exactly two 20 px actions, search chats and new chat. */}
        <span className="side-section__actions">
          {clearable.length > 0 && !filtering && (
            <button type="button" className="side-clear" title={t('tabs.clear.chatsTitle')} onClick={() => props.onClear(clearable.map((c) => c.id))}>
              <ArrowDownToLine size={12} aria-hidden />
              {t('tabs.clear.label')}
            </button>
          )}
          <IconButton size="sm" className="side-section__action" label={t('tabs.chats.search')} icon={<Search />} onClick={props.onSearch} />
          <IconButton size="sm" className="side-section__action" label={t('tabs.chats.new')} icon={<Plus />} onClick={props.onNewChat} />
        </span>
      </div>
      <div className="side-collapse" inert={collapsed || undefined}>
        <div className="side-collapse__inner">
          {total === 0 ? (
            <div className="side-empty">
              <span>{filtering ? t('tabs.sidebarChats.noChatsMatch') : t('tabs.sidebarChats.noOpenChatsAsk')}</span>
              {!filtering && (
                <button type="button" className="side-link" onClick={props.onNewChat}>
                  {t('tabs.sidebarChats.startAChat')}
                </button>
              )}
            </div>
          ) : (
            <div className="side-list" role="listbox" aria-label={t('tabs.sidebarChats.openChats')} {...drop.props}>
              {entries.map(({ key, item: chat, phase }) => {
                const isDragged = chat.id === dragId
                const counted = !isDragged && phase !== 'exit'
                const gapBefore = counted && drop.gap === visual
                if (counted) visual++
                return (
                  <ChatRow
                    key={key}
                    chat={chat}
                    phase={phase}
                    active={phase !== 'exit' && activeChatIds.has(chat.id)}
                    editing={editing === chat.id}
                    showLastUsed={showLastUsed}
                    draggable={manual && !filtering && !chat.draft}
                    gapBefore={gapBefore}
                    dragging={isDragged}
                    focusable={focusId === chat.id}
                    onEditing={(on) => setEditing(on ? chat.id : null)}
                    selected={isSelected(selected, chat.id)}
                    onOpen={(e) => openRow(chat, e)}
                    onClose={() => props.onClose([chat.id])}
                    onMenu={(e) => void openMenu(e, chat)}
                  />
                )
              })}
              {drop.gap !== null && drop.gap >= visual && <div className="side-list__end-gap" aria-hidden />}
            </div>
          )}
          {hidden.length > 0 && (
            <div className="chats-more">
              <button type="button" className="side-link" onClick={() => props.onRows(null)}>
                {t('tabs.sidebarChats.more', { length: hidden.length })}
              </button>
              <HeaderDots needs={hiddenDots.needs} unread={hiddenDots.unread} />
              <span className="chats-more__spacer" />
              <button type="button" className="side-link" onClick={() => void call('pages', 'open', 'apex://chats')}>
                {t('tabs.sidebarChats.allChats')}
              </button>
            </div>
          )}
          {total > 1 && !filtering && (
            <Seam
              orientation="horizontal"
              className="chats-divider"
              label={t('tabs.sidebarChats.chatsShown')}
              value={limit}
              min={1}
              max={total}
              step={1}
              largeStep={5}
              snap={1}
              pixelsPerUnit={CHAT_ROW_HEIGHT}
              valueText={(v) => (v >= total ? t('tabs.sidebarChats.allChatsShown') : t('tabs.sidebarChats.ofChatsShown', { v, total }))}
              resetTo={(current) => (current >= total ? Math.min(total, CHAT_ROWS_DEFAULT) : total)}
              onChange={(v) => setLiveRows(v)}
              onCommit={(v) => props.onRows(v >= total ? null : v)}
            />
          )}
        </div>
      </div>
    </section>
  )
}

/** The section's + button: a draft chat opened as a page. */
export async function startNewChatPage(snapshot: TabsSnapshot, companionId: string): Promise<void> {
  try {
    const draft = await call('chats', 'create', { companionId })
    openChatPage(snapshot, draft.id)
  } catch (err) {
    toast.show({ message: t('tabs.sidebarChats.couldnTStartA', { value: errorText(err) }), tone: 'error' })
  }
}
