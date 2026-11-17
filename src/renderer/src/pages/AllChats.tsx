/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { Ellipsis, MessageSquarePlus, MessagesSquare, Pin, Search, SearchX, X } from 'lucide-react'
import type { ChatSummary, Companion } from '@shared/services'
import { chatUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import '../chat/chat.css'
import { bulkMenu, chatMenu, deleteChats, runChatAction } from '../chat/actions'
import { newDraftChat } from '../chat/ChatView'
import { CompanionAvatar } from '../chat/CompanionAvatar'
import { useChatFace } from '../companion/presence'
import { useCompanionList } from '../chat/hooks'
import { DEFAULT_FILTERS, chatBadge, groupChats, hasFilters, pruneSelection, rangeBetween, toListFilter, type ChatFilters } from '../chat/logic/list'
import { Button, EmptyState, ErrorState, IconButton, InlineRename, RelativeTime, SkeletonRows, cx, showContextMenu, showMenu, toast } from '../ui'
import { skeletonHoldLeft } from '../ui/logic/skeleton' // DS-106
import { FilterChip } from '../settings/kit'
import { dropdownChipLabel, sortEnabled, toggledStatus, type StatusChip } from '../chat/logic/allChatsChips'
import type { MenuItemSpec } from '@shared/menu'
// CH-48, CH-49
import { ChatPreview } from '../chat/ChatPreview'
import { PREVIEW_MIN_WIDTH, bulkAvailability, movePreview, rowClickAction } from '../chat/logic/bulk'
import { t, useT } from '../i18n/useT'
import { useShell } from '../components/shellContext'
import { useMediaQuery } from '../ui'
import { openExportDialog } from '../ui/ExportDialog'
import { handleProjectMenu, projectSubmenu } from '../workspace/projectActions'
import '../chat/chatTools.css'

const PAGE_SIZE = 60

type Result = { phase: 'loading' } | { phase: 'failed'; error: string } | { phase: 'ready'; items: ChatSummary[]; more: boolean }

/** apex://chats: every chat, grouped by date with pinned ones on top, with search, filters and bulk actions. */
// The tab id is part of the mount contract; the page needs no tab-specific state yet.
export function AllChatsPage(_props: { tabId: string }): ReactElement {
  const [filters, setFilters] = useState<ChatFilters>(DEFAULT_FILTERS)
  const [queryInput, setQueryInput] = useState('')
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [result, setResult] = useState<Result>({ phase: 'loading' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  // Selection mode shows every checkbox and the bulk bar; the preview pane shows one chat beside the list.
  const [selectMode, setSelectMode] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewRoom = useMediaQuery(`(min-width: ${PREVIEW_MIN_WIDTH}px)`)
  const td = useT()
  const anchor = useRef<string | null>(null)
  const request = useRef(0)
  const list = useRef<HTMLDivElement>(null)
  const companions = useCompanionList()

  // DS-106: whether the list shows its skeleton (nothing loaded yet); a skeleton that came up stays ~100 ms.
  const firstLoad = useRef(true)
  const load = useCallback(() => {
    const attempt = ++request.current
    const started = performance.now()
    // One extra row says whether there is more to load.
    call('chats', 'list', toListFilter(filters, limit + 1)).then(
      (items) => {
        const apply = (): void => {
          if (attempt !== request.current) return
          firstLoad.current = false
          setResult({ phase: 'ready', items: items.slice(0, limit), more: items.length > limit })
        }
        const hold = firstLoad.current ? skeletonHoldLeft(performance.now() - started) : 0
        if (hold > 0) setTimeout(apply, hold)
        else apply()
      },
      (err: unknown) => {
        if (attempt === request.current) setResult({ phase: 'failed', error: errorText(err) })
      },
    )
  }, [filters, limit])

  useEffect(load, [load])

  // Searching waits for a pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((f) => {
        if (f.query === queryInput) return f
        // Best match ranks by the words; without any it falls back to newest.
        const sort = !queryInput.trim() && f.sort === 'best-match' ? 'recent' : f.sort
        return { ...f, query: queryInput, sort }
      })
      setLimit(PAGE_SIZE)
    }, 200)
    return () => clearTimeout(timer)
  }, [queryInput])

  // Any chat change can move rows between groups and filters; ask again.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = apex.onAppEvent((event) => {
      if (event.type !== 'chats') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(load, 150)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [load])

  const items = useMemo(() => (result.phase === 'ready' ? result.items : []), [result])
  useEffect(() => setSelected((s) => (s.size === 0 ? s : pruneSelection(s, items))), [items])

  const groups = useMemo(() => groupChats(items, filters.sort), [items, filters.sort])
  const order = useMemo(() => groups.flatMap((g) => g.items.map((c) => c.id)), [groups])
  const byId = (id: string): ChatSummary | undefined => items.find((c) => c.id === id)
  const selectedChats = items.filter((c) => selected.has(c.id))
  const selecting = selectMode || selected.size > 0
  const bulk = bulkAvailability(selectedChats)
  const previewChat = previewId ? (items.find((c) => c.id === previewId) ?? null) : null
  const endSelection = (): void => {
    setSelected(new Set())
    setSelectMode(false)
  }
  const bulkProject = (el: HTMLElement): void => {
    const ids = selectedChats.map((c) => c.id)
    const submenu = projectSubmenu(ids)
    void showMenu(submenu.submenu ?? [submenu], el).then((picked) => picked && handleProjectMenu(picked, ids).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' })))
  }
  const filtered = hasFilters(filters) || queryInput.trim() !== ''

  const update = (patch: Partial<ChatFilters>): void => {
    setFilters((f) => ({ ...f, ...patch }))
    setLimit(PAGE_SIZE)
  }

  const clearFilters = (): void => {
    setQueryInput('')
    setFilters(DEFAULT_FILTERS)
    setLimit(PAGE_SIZE)
  }

  const open = (chat: ChatSummary, newTab = false): void => {
    void call('pages', 'open', chatUrl(chat.id), newTab ? { newTab: true, background: true } : undefined)
  }

  const newChat = (): void => {
    void newDraftChat().then((id) => id && void call('pages', 'open', chatUrl(id)))
  }

  const toggle = (id: string, range: boolean): void => {
    setSelected((s) => {
      const next = new Set(s)
      if (range && anchor.current) {
        for (const r of rangeBetween(order, anchor.current, id)) next.add(r)
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!range) anchor.current = id
  }

  const rowAction = (picked: string | null, chat: ChatSummary): void => {
    // A row that is part of a selection acts for the whole selection.
    const targets = selected.has(chat.id) && selected.size > 1 ? selectedChats : [chat]
    void runChatAction(picked, targets, {
      open: () => open(chat),
      rename: () => setRenaming(chat.id),
      newChat,
      deleted: () => setSelected(new Set()),
    })
  }

  const menuFor = (chat: ChatSummary) => (selected.has(chat.id) && selected.size > 1 ? bulkMenu(selectedChats) : chatMenu(chat, 'row'))

  const focusRow = (id: string | undefined): void => {
    if (!id) return
    list.current?.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(id)}"]`)?.focus()
  }

  const onRowKey = (e: KeyboardEvent<HTMLElement>, chat: ChatSummary): void => {
    if (e.target !== e.currentTarget) return
    const at = order.indexOf(chat.id)
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        const next = order[at + (e.key === 'ArrowDown' ? 1 : -1)]
        if (e.shiftKey && next) toggle(next, false)
        focusRow(next)
        // CH-49: ↑/↓ move the preview with the focus.
        if (previewId && previewRoom && !selecting) setPreviewId(movePreview(order, chat.id, e.key === 'ArrowDown' ? 1 : -1))
        break
      }
      case 'Home':
      case 'End':
        e.preventDefault()
        focusRow(e.key === 'Home' ? order[0] : order[order.length - 1])
        break
      case 'Enter':
        e.preventDefault()
        open(chat, e.metaKey || e.ctrlKey)
        break
      case ' ':
        e.preventDefault()
        toggle(chat.id, e.shiftKey)
        break
      case 'F2':
        e.preventDefault()
        setRenaming(chat.id)
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        void deleteChats(selected.has(chat.id) ? selectedChats : [chat]).then((done) => done && setSelected(new Set()))
        break
      case 'Escape':
        if (selecting) {
          e.preventDefault()
          endSelection()
        } else if (previewId) {
          e.preventDefault()
          setPreviewId(null)
        }
        break
    }
  }

  // DS-101: the more button carries selection and mark-all-read; the chips' menus pick one value each.
  const openMore = async (el: HTMLElement): Promise<void> => {
    const picked = await showMenu(
      [
        { id: 'select', label: selectMode ? td('chatTools.bulk.done') : td('chatTools.allChats.selectChats'), enabled: items.length > 0 },
        { id: 'read-all', label: td('chatTools.allChats.markAllRead'), enabled: items.some((c) => c.unread) },
      ],
      el,
    )
    if (picked === 'select') {
      if (selectMode) endSelection()
      else setSelectMode(true)
    } else if (picked === 'read-all') {
      void call('chats', 'markAllRead').catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
    }
  }
  const pick = async <V extends string>(el: HTMLElement, current: V, options: readonly { value: V; label: string; enabled?: boolean }[]): Promise<V | null> => {
    const specs: MenuItemSpec[] = options.map((o) => ({ id: o.value, label: o.label, type: 'radio', checked: o.value === current, enabled: o.enabled }))
    const picked = await showMenu(specs, el)
    return (options.find((o) => o.value === picked)?.value ?? null) as V | null
  }
  const companionLabel = (c: Companion): string => (c.hidden ? td('chatTools.allChats.hiddenCompanion', { name: c.name }) : c.name)
  const companionChoices = [{ value: '', label: td('chatTools.allChats.allCompanions') }, ...companions.items.map((c) => ({ value: c.id, label: companionLabel(c) }))]
  const routineChoices = [
    { value: 'all' as const, label: td('chatTools.allChats.routineAll') },
    { value: 'exclude' as const, label: td('chatTools.allChats.routineExclude') },
    { value: 'only' as const, label: td('chatTools.allChats.routineOnly') },
  ]
  const sortChoices = [
    { value: 'recent' as const, label: td('chatTools.allChats.sortRecent') },
    { value: 'oldest' as const, label: td('chatTools.allChats.sortOldest') },
    { value: 'best-match' as const, label: td('chatTools.allChats.sortBest'), enabled: sortEnabled('best-match', queryInput) },
  ]
  const toggleStatus = (status: StatusChip): void => update({ status: toggledStatus(filters.status, status) })
  const showPreview = previewRoom && result.phase === 'ready' && items.length > 0 && !selecting

  return (
    <div className="chats-page">
      {/* The 672 px column widens to make room for the preview pane beside the list. */}
      <div className={cx('chats-page__inner', showPreview && 'chats-page__inner--preview')}>
        {/* DS-101: the header, search and chips stay put with a fade under them. */}
        <div className="chats-page__top">
          <header className="chats-page__header">
            <h1>{td('chatTools.allChats.title')}</h1>
            <div className="chats-page__actions">
              <IconButton size="lg" className="chats-page__more" label={td('chatTools.allChats.more')} icon={<Ellipsis />} aria-haspopup="menu" onClick={(e) => void openMore(e.currentTarget)} />
              <Button variant="primary" className="chats-page__new" icon={<MessageSquarePlus size={15} />} onClick={newChat}>
                {td('chatTools.allChats.newChat')}
              </Button>
            </div>
          </header>

          <div className="chats-filters" role="search">
            <label className="chats-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                value={queryInput}
                // DS-101: the search is focused on arrival.
                autoFocus
                placeholder={td('chatTools.allChats.search')}
                aria-label={td('chatTools.allChats.searchLabel')}
                onChange={(e) => setQueryInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && queryInput) {
                    e.preventDefault()
                    setQueryInput('')
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    focusRow(order[0])
                  }
                }}
              />
              {queryInput && <IconButton size="sm" label={td('chatTools.allChats.clearSearch')} icon={<X />} onClick={() => setQueryInput('')} />}
            </label>
            <div className="chats-filters__row" role="group" aria-label={td('chatTools.allChats.filters')}>
              <FilterChip label={td('chatTools.allChats.unread')} pressed={filters.status === 'unread'} onClick={() => toggleStatus('unread')} />
              <FilterChip label={td('chatTools.allChats.waiting')} pressed={filters.status === 'needs-input'} onClick={() => toggleStatus('needs-input')} />
              <FilterChip label={td('chatTools.allChats.archived')} pressed={filters.status === 'archived'} onClick={() => toggleStatus('archived')} />
              <FilterChip
                menu
                label={dropdownChipLabel(filters.companionId ?? '', '', td('chatTools.allChats.companion'), companionChoices)}
                pressed={filters.companionId !== null}
                onClick={(el) => void pick(el, filters.companionId ?? '', companionChoices).then((v) => v !== null && update({ companionId: v || null }))}
              />
              <FilterChip
                menu
                label={dropdownChipLabel(filters.routine, 'all', td('chatTools.allChats.routines'), routineChoices)}
                pressed={filters.routine !== 'all'}
                onClick={(el) => void pick(el, filters.routine, routineChoices).then((v) => v && update({ routine: v }))}
              />
              {filtered && (
                <button type="button" className="chats-filters__clear" onClick={clearFilters}>
                  {td('chatTools.allChats.clearFilters')}
                </button>
              )}
              <span className="chats-filters__sort">
                <FilterChip
                  menu
                  label={sortChoices.find((o) => o.value === filters.sort)?.label ?? td('chatTools.allChats.sort')}
                  onClick={(el) => void pick(el, filters.sort, sortChoices).then((v) => v && update({ sort: v }))}
                />
              </span>
            </div>
          </div>
          {selecting && (
            <div className="chats-bulk cd-bulk" role="toolbar" aria-label={t('chatTools.allChats.selectedChats')}>
              <span className="cd-bulk__count" aria-live="polite">{td('chatTools.bulk.count', { count: selected.size })}</span>
              <Button size="sm" variant="ghost" disabled={selected.size === order.length} onClick={() => setSelected(new Set(order))}>{td('chatTools.bulk.selectAll')}</Button>
              <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>{td('chatTools.bulk.clear')}</Button>
              <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => void runChatAction(bulk.read, selectedChats)}>
                {bulk.read === 'mark-read' ? td('chatTools.bulk.markRead') : td('chatTools.bulk.markUnread')}
              </Button>
              <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => void runChatAction(bulk.archive, selectedChats)}>
                {bulk.archive === 'unarchive' ? td('chatTools.bulk.unarchive') : td('chatTools.bulk.archive')}
              </Button>
              <Button size="sm" variant="ghost" disabled={selected.size === 0} aria-haspopup="menu" onClick={(e) => bulkProject(e.currentTarget)}>{td('chatTools.bulk.project')}</Button>
              <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => void openExportDialog({ kind: 'chat', ids: selectedChats.map((c) => c.id), title: selectedChats[0]?.title ?? '' })}>{td('chatTools.bulk.export')}</Button>
              <Button size="sm" variant="danger" disabled={selected.size === 0} onClick={() => void deleteChats(selectedChats).then((done) => done && endSelection())}>{td('chatTools.bulk.delete')}</Button>
              <Button size="sm" variant="secondary" onClick={endSelection}>{td('chatTools.bulk.done')}</Button>
            </div>
          )}
        </div>

        <div className="cd-allchats">
        <div className="chats-list cd-allchats__list" ref={list}>
          {result.phase === 'loading' && <SkeletonRows rows={6} avatar label={t('chatTools.allChats.loadingChats')} />}
          {result.phase === 'failed' && <ErrorState title={t('chatTools.allChats.couldnTLoadYour')} message={result.error} onRetry={load} />}
          {result.phase === 'ready' && items.length === 0 && (
            filtered ? (
              <EmptyState icon={<SearchX />} title={t('chatTools.allChats.noChatsMatch')} description={t('chatTools.allChats.tryOtherWordsOr')} action={<Button onClick={clearFilters}>{t('chatTools.allChats.clearFilters')}</Button>} />
            ) : (
              <EmptyState
                icon={<MessagesSquare />}
                title={t('chatTools.allChats.noChatsYet')}
                description={t('chatTools.allChats.chatsYouStartWith')}
                action={<Button variant="primary" icon={<MessageSquarePlus size={14} />} onClick={newChat}>{t('chatTools.allChats.newChat')}</Button>}
              />
            )
          )}
          {groups.map((group) => (
            <section key={group.id} className="chats-group" aria-labelledby={`chats-group-${group.id}`}>
              <h2 id={`chats-group-${group.id}`} className="chats-group__title">{group.label}</h2>
              <ul className="chats-group__rows" role="list">
                {group.items.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    companion={companions.items.find((c) => c.id === chat.companionId) ?? (companions.loaded ? null : undefined)}
                    selected={selected.has(chat.id)}
                    selecting={selecting}
                    previewing={previewId === chat.id}
                    renaming={renaming === chat.id}
                    onRenamingChange={(on) => setRenaming(on ? chat.id : null)}
                    onToggle={(range) => toggle(chat.id, range)}
                    onOpen={(newTab) => open(chat, newTab)}
                    onClickRow={(shift, mod) => {
                      switch (rowClickAction({ previewAvailable: previewRoom, selecting, shift, mod })) {
                        case 'toggle-range':
                          return toggle(chat.id, true)
                        case 'toggle':
                          return toggle(chat.id, false)
                        case 'open-new-tab':
                          return open(chat, true)
                        case 'preview':
                          return setPreviewId(chat.id)
                        case 'open':
                          return open(chat)
                      }
                    }}
                    onKeyDown={(e) => onRowKey(e, chat)}
                    onMenu={(e) => void showContextMenu(e, menuFor(chat)).then((picked) => rowAction(picked, chat))}
                    onMenuButton={(el) => void showMenu(menuFor(chat), el).then((picked) => rowAction(picked, chat))}
                  />
                ))}
              </ul>
            </section>
          ))}
          {result.phase === 'ready' && result.more && (
            <div className="chats-list__more">
              <Button size="sm" onClick={() => setLimit((n) => n + PAGE_SIZE)}>{t('chatTools.allChats.showMore')}</Button>
            </div>
          )}
        </div>
        {/* CH-49: the preview pane, where there is room for it. */}
        {showPreview && (
          <ChatPreview
            chat={previewChat}
            companionName={companions.items.find((c) => c.id === previewChat?.companionId)?.name ?? t('chatTools.allChats.companion')}
            onOpen={(c) => open(c)}
            onClose={() => setPreviewId(null)}
          />
        )}
        </div>
      </div>
    </div>
  )
}

interface ChatRowProps {
  chat: ChatSummary
  companion: Companion | null | undefined
  selected: boolean
  selecting: boolean
  /** The row shown in the preview pane. */
  previewing: boolean
  renaming: boolean
  onRenamingChange(on: boolean): void
  onToggle(range: boolean): void
  onOpen(newTab: boolean): void
  /** A plain click previews in a wide window, else opens (rowClickAction). */
  onClickRow(shift: boolean, mod: boolean): void
  onKeyDown(e: KeyboardEvent<HTMLElement>): void
  onMenu(e: MouseEvent<HTMLElement>): void
  onMenuButton(anchor: HTMLElement): void
}

function ChatRow({ chat, companion, selected, selecting, previewing, renaming, onRenamingChange, onToggle, onOpen, onClickRow, onKeyDown, onMenu, onMenuButton }: ChatRowProps): ReactElement {
  const badge = chatBadge(chat)
  // The face shows the chat's state (CO-18, DS-67), live from the presence store.
  const face = useChatFace(chat)
  const shell = useShell()
  return (
    <li
      className={cx('chats-row', selected && 'chats-row--selected', selecting && 'chats-row--selecting', chat.unread && 'chats-row--unread', previewing && 'chats-row--selected')}
      aria-current={previewing || undefined}
      data-chat-row={chat.id}
      tabIndex={0}
      data-selected={selected || undefined}
      aria-label={`${chat.title}${badge ? `, ${badge.label}` : ''}${selected ? ', selected' : ''}`}
      onClick={(e) => {
        if (renaming) return
        onClickRow(e.shiftKey, e.metaKey || e.ctrlKey)
      }}
      onDoubleClick={() => !renaming && !selecting && onOpen(false)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onOpen(true)
        }
      }}
      onKeyDown={onKeyDown}
      onContextMenu={onMenu}
    >
      <input
        type="checkbox"
        className="chats-row__check"
        checked={selected}
        aria-label={t('chatTools.allChats.select', { title: chat.title })}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          onToggle(e.shiftKey)
        }}
        onChange={() => undefined}
      />
      {companion ? (
        // DS-122: the face opens the companion's card.
        <button
          type="button"
          className="chats-row__face"
          aria-label={t('coCard.openProfile', { companion: companion.name })}
          title={t('coCard.openProfile', { companion: companion.name })}
          onClick={(e) => {
            e.stopPropagation()
            shell.openCompanionCard(companion.id, 'general')
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <CompanionAvatar companion={companion} size={30} mood={face.mood} mark={face.mark} label="" />
        </button>
      ) : (
        <CompanionAvatar companion={companion} size={30} mood={face.mood} mark={face.mark} label="" />
      )}
      <div className="chats-row__main">
        <InlineRename
          className="chats-row__title"
          value={chat.title}
          label={t('chatTools.allChats.chatName')}
          activation="none"
          maxLength={120}
          editing={renaming}
          onEditingChange={onRenamingChange}
          onCommit={async (title) => {
            try {
              await call('chats', 'rename', chat.id, title)
            } catch (err) {
              toast.show({ message: errorText(err), tone: 'error' })
              throw err
            }
          }}
        />
      </div>
      {/* DS-101: one line; the state reads from the face's marks (DS-67) and the row's label, not a coloured pill. */}
      {chat.pinned && <Pin size={13} className="chats-row__pin" aria-label={t('chatTools.allChats.pinned')} />}
      <RelativeTime value={chat.lastActiveAt} style="short" className="chats-row__time" />
      <IconButton
        size="sm"
        label={t('chatTools.allChats.actions')}
        icon={<Ellipsis />}
        aria-haspopup="menu"
        className="chats-row__menu"
        onClick={(e) => {
          e.stopPropagation()
          onMenuButton(e.currentTarget)
        }}
      />
    </li>
  )
}
