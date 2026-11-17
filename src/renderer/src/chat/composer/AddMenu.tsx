/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AppWindow, AudioLines, ChevronLeft, ChevronRight, FolderOpen, Paperclip, Plug, Plus, Search, Sparkles } from 'lucide-react'
import { MESSAGE_ATTACHMENTS_MAX } from '@shared/chats'
import { t } from '@shared/i18n/core'
import type { MeetingSummary } from '@shared/meetings'
import type { Connector } from '@shared/services'
import { call } from '../../api'
import { IconButton, Spinner, cx, formatRelative, toast } from '../../ui'
import { placePopover, type Rect } from '../../ui/logic/popover'
import { attachToDraft } from '../attachments/drafts'
import { useSkills, useTabs } from '../hooks'
import { hostLabel } from '../logic/intake'
import { Favicon } from './icons'
// CH-21: the activity-memory switch
import { ActivityMark } from '../../activity/ActivityGlyph'
import { ACTIVITY_ROW_ID, useActivityChatRow } from '../../activity/chatSwitch'
import { useConnectorList, skillsFor, webTabs } from './data'
import { addSource, pickFiles } from './store'
// CH-21: the local folder
import { shareFolder } from '../../workspace/FolderAccessDialog'
import { edgeRow, listState, menuKey, rootRows, type ListState, type MenuLevel, type MenuRow, type SubmenuId } from '../logic/addMenu'

// The composer's + menu (CH-21, DS-126): Files…, then Skills, Meetings,
// Connectors and Tabs submenus (each with its own search, empty and
// no-match states), then up to three recent tabs. It opens upward,
// left-aligned with +, 11 px above it. A submenu cascades 3 px to the side
// when the chat's column has room, and otherwise opens in place of the
// menu with a back row, so it never reaches over a page. The card follows
// the DS-94 look (ui-pop) and closes on Esc, Tab, a click outside or blur.

export interface AddMenuProps {
  chatId: string
  companionId: string
  name: string
  /** Skills insert "/name " into the draft, as the / list does. */
  onInsert(text: string): void
  /** Picking a connector behaves like mentioning it (a hint, or a new chat). */
  onConnector(connector: Connector): void
  disabled?: boolean
}

const WIDTH = 264
const SUB_WIDTH = 288
const GAP = 11
const CASCADE = 3

type Loaded<T> = T[] | 'loading' | 'error'

const LABELS = (): Record<'files' | SubmenuId | 'recent', string> => ({
  files: t('composer.add.files'),
  skills: t('composer.add.skills'),
  meetings: t('composer.add.meetings'),
  connectors: t('composer.add.connectors'),
  tabs: t('composer.add.tabs'),
  recent: t('composer.add.recent'),
})

const SUB_ICON: Record<SubmenuId, ReactElement> = {
  skills: <Sparkles />,
  meetings: <AudioLines />,
  connectors: <Plug />,
  tabs: <AppWindow />,
}

export function AddMenu({ chatId, companionId, name, onInsert, onConnector, disabled }: AddMenuProps): ReactElement {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <IconButton
        ref={button}
        size="md"
        label={t('composer.add.button')}
        icon={<Plus />}
        aria-haspopup="menu"
        aria-expanded={open}
        data-menu-open={open ? '' : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      />
      {open && button.current &&
        createPortal(
          <MenuFrame
            anchor={button.current}
            chatId={chatId}
            companionId={companionId}
            name={name}
            onInsert={onInsert}
            onConnector={onConnector}
            onClose={(refocus) => {
              setOpen(false)
              if (refocus) button.current?.focus({ preventScroll: true })
            }}
          />,
          document.body,
        )}
    </>
  )
}

interface FrameProps extends Omit<AddMenuProps, 'disabled'> {
  anchor: HTMLElement
  onClose(refocus: boolean): void
}

function MenuFrame({ anchor, chatId, companionId, name, onInsert, onConnector, onClose }: FrameProps): ReactElement {
  const frame = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const sub = useRef<HTMLDivElement>(null)
  const [level, setLevel] = useState<MenuLevel>('root')
  const [place, setPlace] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [subPlace, setSubPlace] = useState<{ left: number; top: number; maxHeight: number } | 'inline' | null>(null)
  const tabs = useTabs()
  const skills = useSkills()
  const connectors = useConnectorList(companionId)
  const activity = useActivityChatRow(chatId) // CH-21
  const [meetings, setMeetings] = useState<Loaded<MeetingSummary>>('loading')
  const [attempt, setAttempt] = useState(0)

  const open = useMemo(() => webTabs(tabs.tabs), [tabs])

  const inline = subPlace === 'inline'
  // Measure, then place: it shows only once placed, so it never jumps. A
  // submenu shown in place changes the card's height, so it is placed again.
  useLayoutEffect(() => {
    const el = main.current
    if (!el) return
    const r = anchor.getBoundingClientRect()
    const rect: Rect = { left: r.left, top: r.top, width: r.width, height: r.height }
    setPlace(placePopover(rect, { width: el.offsetWidth, height: el.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, { side: 'above', gap: GAP, align: 'start' }))
  }, [anchor, inline, level])

  // A submenu cascades only inside the chat's own column.
  useLayoutEffect(() => {
    if (level === 'root' || !main.current) {
      setSubPlace(null)
      return
    }
    if (!place || subPlace === 'inline') return
    const box = main.current.getBoundingClientRect()
    const column = (anchor.closest('.chat-view, .nt, .chat-composer') ?? document.body).getBoundingClientRect()
    const left = box.right + CASCADE
    if (left + SUB_WIDTH > Math.min(column.right, window.innerWidth - 8)) {
      setSubPlace('inline')
      return
    }
    const height = sub.current?.scrollHeight ?? box.height
    const bottom = box.bottom
    const top = Math.max(8, bottom - height)
    setSubPlace({ left: Math.round(left), top: Math.round(top), maxHeight: Math.round(bottom - 8) })
  }, [level, place, anchor, subPlace === 'inline'])

  useEffect(() => {
    if (level !== 'meetings') return
    setMeetings('loading')
    let live = true
    call('meetings', 'list').then(
      (items) => live && setMeetings([...items].sort((a, b) => b.startedAt - a.startedAt)),
      () => live && setMeetings('error'),
    )
    return () => {
      live = false
    }
  }, [level, attempt])

  // A click outside, the window losing focus or a resize close it.
  useEffect(() => {
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (frame.current?.contains(target)) return
      if (anchor.contains(target)) {
        // The press on + closes it; the click that follows must not reopen it.
        const swallow = (ev: Event): void => ev.stopPropagation()
        anchor.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => anchor.removeEventListener('click', swallow, { capture: true }), 600)
      }
      onClose(false)
    }
    const dismiss = (): void => onClose(false)
    // Esc closes it even while focus is still in the composer (inside, the lists close a submenu first).
    const onKey = (e: Event): void => {
      if ((e as globalThis.KeyboardEvent).key !== 'Escape' || frame.current?.contains(e.target as Node | null)) return
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [anchor, onClose])

  const root = [...rootRows(LABELS(), open.map((tab) => ({ id: tab.id, title: tab.title, url: tab.url })), /* CH-21 */ { label: t('workspace.folder.menuItem'), detail: t('workspace.folder.menuDetail') }), /* CH-21 */ ...activity.rows]
  const favicon = (tabId: string): string | null => tabs.tabs.find((tab) => tab.id === tabId)?.favicon ?? null

  const subRows: Record<SubmenuId, Loaded<MenuRow>> = {
    skills: skillsFor(skills, companionId).map((s) => ({
      id: `skill:${s.name}`,
      label: `/${s.name}`,
      kind: 'item' as const,
      detail: s.description || (s.owner === companionId ? t('composer.add.own', { name }) : t('composer.add.shared')),
    })),
    meetings: meetings === 'loading' || meetings === 'error' ? meetings : meetings.map((m) => ({ id: `meeting:${m.id}`, label: m.title || t('composer.mention.untitled'), kind: 'item' as const, detail: meetingDetail(m) })),
    connectors: connectors === null ? 'loading' : connectors.map((c) => ({ id: `connector:${c.id}`, label: c.name, kind: 'item' as const, detail: hostLabel(c.url) })),
    tabs: open.map((tab) => ({ id: `tab:${tab.id}`, label: tab.title || tab.url, kind: 'item' as const, detail: hostLabel(tab.url), keywords: tab.url })),
  }

  const choose = (id: string): void => {
    // CH-21: the activity switch flips in place and leaves the menu open.
    if (id === ACTIVITY_ROW_ID) return activity.toggle()
    const [kind, value = ''] = id.split(/:(.*)/s)
    onClose(true)
    switch (kind) {
      case 'files':
        void pickFiles(chatId)
        return
      // CH-21, CH-43: pick a folder, then its access
      case 'folder':
        void shareFolder(chatId).catch((err: unknown) => toast.show({ message: err instanceof Error ? err.message : String(err), tone: 'error' }))
        return
      case 'tab':
        void addSource(chatId, { type: 'tab', tabId: value })
        return
      case 'skill':
        onInsert(`/${value} `)
        return
      case 'meeting': {
        const meeting = Array.isArray(meetings) ? meetings.find((m) => m.id === value) : undefined
        // Meetings ride the composer draft, whose held send waits for the transcript (MV-14).
        if (!attachToDraft(chatId, { attachment: { kind: 'meeting', meetingId: value }, label: meeting?.title ?? '' })) {
          toast.show({ message: t('composer.gate.tooMany', { count: MESSAGE_ATTACHMENTS_MAX }), tone: 'error' })
        }
        return
      }
      case 'connector': {
        const connector = connectors?.find((c) => c.id === value)
        if (connector) onConnector(connector)
        return
      }
      case 'go':
        void call('pages', 'open', value)
        return
    }
  }

  const style = (p: { left: number; top: number; maxHeight: number } | null, width: number): CSSProperties =>
    ({ width, left: p?.left ?? 0, top: p?.top ?? 0, maxHeight: p?.maxHeight, visibility: p ? undefined : 'hidden', '--pop-row': '36px' }) as CSSProperties

  const submenu = level === 'root' ? null : (
    <Submenu
      key={level}
      level={level}
      rows={subRows[level]}
      name={name}
      inline={inline}
      favicon={favicon}
      onChoose={choose}
      onBack={() => {
        setLevel('root')
        requestAnimationFrame(() => main.current?.querySelector<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true }))
      }}
      onClose={() => onClose(true)}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  )

  return (
    <div ref={frame} className="cmp-menu" data-level={level}>
      <div ref={main} className={cx('ui-pop', 'cmp-menu__card', place && 'cmp-menu__card--placed')} style={style(place, WIDTH)} data-placed={place ? '' : undefined}>
        {inline && submenu ? (
          submenu
        ) : (
          <RootList
            rows={root}
            parentOf={level === 'root' ? null : `sub:${level}`}
            favicon={favicon}
            onChoose={choose}
            onOpen={(id) => setLevel(id)}
            onClose={() => onClose(true)}
          />
        )}
      </div>
      {!inline && submenu && (
        <div ref={sub} className="ui-pop cmp-menu__card cmp-menu__card--sub" style={style(subPlace === null ? null : subPlace, SUB_WIDTH)} data-placed={subPlace ? '' : undefined}>
          {submenu}
        </div>
      )}
    </div>
  )
}

function meetingDetail(m: MeetingSummary): string {
  if (m.status === 'live') return t('composer.meeting.live')
  if (m.status === 'finishing') return t('composer.meeting.finishing')
  return formatRelative(m.startedAt)
}

function rowIcon(row: MenuRow, favicon: (tabId: string) => string | null): ReactNode {
  if (row.id === 'files') return <Paperclip />
  if (row.id === 'folder') return <FolderOpen /> // CH-21
  if (row.id === ACTIVITY_ROW_ID) return <ActivityMark /> // CH-21
  if (row.kind === 'submenu') return SUB_ICON[row.id.slice(4) as SubmenuId] ?? null
  if (row.id.startsWith('tab:')) return <Favicon src={favicon(row.id.slice(4))} />
  return null
}

interface RootListProps {
  rows: MenuRow[]
  /** The submenu that is open beside the list; its row stays highlighted. */
  parentOf: string | null
  favicon(tabId: string): string | null
  onChoose(id: string): void
  onOpen(submenu: SubmenuId): void
  onClose(): void
}

function RootList({ rows, parentOf, favicon, onChoose, onOpen, onClose }: RootListProps): ReactElement {
  const id = useId()
  const list = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => edgeRow(rows, 'first'))
  useEffect(() => {
    if (parentOf === null) list.current?.focus({ preventScroll: true })
  }, [parentOf])

  const act = (key: string, e?: KeyboardEvent): void => {
    const r = menuKey(key, rows, active, 'root')
    if (!r) return
    e?.preventDefault()
    e?.stopPropagation()
    if (r.type === 'move') setActive(r.active)
    else if (r.type === 'open') onOpen(r.submenu)
    else if (r.type === 'choose') onChoose(r.row.id)
    else if (r.type === 'close') onClose()
  }

  return (
    <div className="ui-pop__body">
      <div
        ref={list}
        className="ui-pop__list"
        role="menu"
        aria-label={t('composer.add.menu')}
        tabIndex={-1}
        aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
        onKeyDown={(e) => act(e.key, e)}
      >
        {rows.map((row, index) => {
          if (row.kind === 'separator') return <div key={row.id} className="ui-pop__sep" role="separator" />
          if (row.kind === 'header') return <div key={row.id} className="ui-pop__header" role="presentation">{row.label}</div>
          const open = parentOf === row.id
          return (
            <div
              key={row.id}
              id={`${id}-${index}`}
              role={row.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={row.checked}
              aria-haspopup={row.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={row.kind === 'submenu' ? open : undefined}
              className={cx('ui-pop__item', (index === active || open) && 'ui-pop__item--active')}
              onPointerMove={() => index !== active && setActive(index)}
              onClick={() => {
                setActive(index)
                const sub = row.kind === 'submenu' ? (row.id.slice(4) as SubmenuId) : null
                if (sub) onOpen(sub)
                else onChoose(row.id)
              }}
            >
              <span className="ui-pop__icon" aria-hidden="true">{rowIcon(row, favicon)}</span>
              <span className="ui-pop__label">{row.label}</span>
              {row.kind === 'submenu' && <ChevronRight className="ui-pop__trail" aria-hidden="true" />}
              {row.checked !== undefined && <span className={cx('am-menu-switch', row.checked && 'am-menu-switch--on')} aria-hidden="true" />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface SubmenuProps {
  level: SubmenuId
  rows: Loaded<MenuRow>
  name: string
  inline: boolean
  favicon(tabId: string): string | null
  onChoose(id: string): void
  onBack(): void
  onClose(): void
  onRetry(): void
}

const SEARCH: Record<SubmenuId, () => string> = {
  skills: () => t('composer.add.search.skills'),
  meetings: () => t('composer.add.search.meetings'),
  connectors: () => t('composer.add.search.connectors'),
  tabs: () => t('composer.add.search.tabs'),
}

/** Each empty state says why, and offers the next step. */
function emptyState(level: SubmenuId, name: string): { text: string; action: MenuRow | null } {
  switch (level) {
    case 'skills':
      return { text: t('composer.add.empty.skills', { name }), action: { id: 'go:atelier://skills', label: t('composer.add.empty.skillsAction'), kind: 'item' } }
    case 'meetings':
      return { text: t('composer.add.empty.meetings'), action: { id: 'go:atelier://meetings', label: t('composer.add.empty.meetingsAction'), kind: 'item' } }
    case 'connectors':
      return { text: t('composer.add.empty.connectors', { name }), action: { id: 'go:atelier://connectors', label: t('composer.add.empty.connectorsAction'), kind: 'item' } }
    case 'tabs':
      return { text: t('composer.add.empty.tabs'), action: null }
  }
}

function Submenu({ level, rows, name, inline, favicon, onChoose, onBack, onClose, onRetry }: SubmenuProps): ReactElement {
  const id = useId()
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const view: ListState = listState(rows === 'loading' || rows === 'error' ? rows : rows, query)
  const empty = emptyState(level, name)
  const navRows: MenuRow[] =
    view.kind === 'rows' ? view.rows : view.kind === 'empty' && empty.action ? [empty.action] : view.kind === 'error' ? [{ id: 'retry', label: t('composer.add.retry'), kind: 'item' }] : []
  const [active, setActive] = useState(-1)
  useEffect(() => setActive(edgeRow(navRows, 'first')), [query, view.kind, navRows.length])
  useEffect(() => {
    search.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (row: MenuRow): void => {
    if (row.id === 'retry') onRetry()
    else onChoose(row.id)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return
    const inSearch = e.target === search.current
    const r = menuKey(e.key, navRows, active, level, inSearch ? query : null)
    if (!r) return
    e.preventDefault()
    e.stopPropagation()
    if (r.type === 'move') setActive(r.active)
    else if (r.type === 'choose') choose(r.row)
    else if (r.type === 'back') onBack()
    else if (r.type === 'close') onClose()
  }

  const title = { skills: t('composer.add.skills'), meetings: t('composer.add.meetings'), connectors: t('composer.add.connectors'), tabs: t('composer.add.tabs') }[level]
  return (
    <div className="ui-pop__body cmp-menu__sub" onKeyDown={onKeyDown}>
      {inline && (
        <button type="button" className="cmp-menu__back" onClick={onBack}>
          <ChevronLeft aria-hidden="true" />
          <span>{title}</span>
          <span className="ui-sr-only">, {t('composer.add.back')}</span>
        </button>
      )}
      <label className="ui-pop__search">
        <Search aria-hidden="true" />
        <input
          ref={search}
          type="text"
          value={query}
          placeholder={SEARCH[level]()}
          aria-label={SEARCH[level]()}
          aria-controls={`${id}-list`}
          aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div ref={list} id={`${id}-list`} className="ui-pop__list cmp-menu__list" role="menu" aria-label={title} tabIndex={-1}>
        {view.kind === 'loading' && (
          <div className="cmp-menu__note" role="status">
            <Spinner size={12} />
            {t('composer.add.loading')}
          </div>
        )}
        {view.kind === 'error' && <div className="cmp-menu__note" role="alert">{t('composer.add.loadFailed')}</div>}
        {view.kind === 'empty' && <div className="cmp-menu__note">{empty.text}</div>}
        {view.kind === 'no-match' && <div className="cmp-menu__note" role="status">{t('composer.add.noMatch', { query: query.trim() })}</div>}
        {navRows.map((row, index) => (
          <div
            key={row.id}
            id={`${id}-${index}`}
            data-index={index}
            role="menuitem"
            className={cx('ui-pop__item', index === active && 'ui-pop__item--active', view.kind !== 'rows' && 'ui-pop__item--create')}
            onPointerMove={() => index !== active && setActive(index)}
            onClick={() => choose(row)}
          >
            {row.id.startsWith('tab:') && <span className="ui-pop__icon" aria-hidden="true"><Favicon src={favicon(row.id.slice(4))} /></span>}
            <span className="ui-pop__label">
              {row.label}
              {row.detail && <span className="ui-pop__desc">{row.detail}</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
