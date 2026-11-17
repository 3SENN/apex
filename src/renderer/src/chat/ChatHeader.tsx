/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement, type ReactNode } from 'react'
import { AppWindow, CalendarClock, Ellipsis, Pause } from 'lucide-react'
import type { CompanionMood } from '@shared/companion'
import type { MenuItemSpec } from '@shared/menu'
import type { ChatSummary, Companion } from '@shared/services'
import { atelier, call, errorText } from '../api'
import { useShell } from '../components/shellContext'
import { IconButton, InlineRename, confirm, cx, menuSeparator, showMenu, toast } from '../ui'
import { chatMenu, runChatAction, type ActionHooks } from './actions'
import { CompanionAvatar } from './CompanionAvatar'
import { useRoutines, useTabs } from './hooks'
import { patchChat, type ChatState } from './store'
import { t } from '../i18n/useT'
import { activityStatus } from './logic/status' // CH-20
import { DetailsToggle } from './DetailsPanel' // CH-33
import { useDetailsStore } from './detailsStore'
import { showChatFiles } from './holdings/ChatFilesButton' // CH-28

const CHAT_FILES_ITEM = 'c4:chat-files'
/** DS-49: the move back into the side panel lives in ⋯ (DS-65's control). */
const COLLAPSE_ITEM = 'ds49:to-panel'
import { PrivateHeaderChip } from './ChatBanners' // CH-30

export interface ChatTitleProps {
  chatId: string
  summary: ChatSummary
  editing: boolean
  onEditingChange(editing: boolean): void
  className?: string
}

/** The chat's title; click (or Rename in a menu) to rename it in place. */
export function ChatTitle({ chatId, summary, editing, onEditingChange, className }: ChatTitleProps): ReactElement {
  return (
    <InlineRename
      className={cx('chat-title', className)}
      value={summary.title}
      label={t('chat.header.chatName')}
      placeholder={t('chat.header.newChat')}
      maxLength={120}
      editing={editing}
      onEditingChange={onEditingChange}
      onCommit={async (title) => {
        try {
          patchChat(chatId, { summary: await call('chats', 'rename', chatId, title) })
        } catch (err) {
          toast.show({ message: errorText(err), tone: 'error' })
          throw err
        }
      }}
    />
  )
}

/** SK-11: which routine produced this chat, with quick routine actions. */
export function RoutinePill({ routineId }: { routineId: string }): ReactElement {
  const routines = useRoutines()
  const routine = routines?.find((r) => r.id === routineId)
  const deleted = routines !== null && !routine
  const open = async (anchor: Element): Promise<void> => {
    if (!routine) {
      void call('pages', 'open', 'atelier://routines')
      return
    }
    const items: MenuItemSpec[] = [
      { id: 'edit', label: t('chat.header.editRoutine') },
      { id: 'toggle', label: routine.enabled ? t('chat.header.pauseRoutine') : t('chat.header.resumeRoutine') },
      { id: 'run', label: t('chat.header.runNow') },
      { id: 'all', label: t('chat.header.allRoutines') },
      menuSeparator(),
      { id: 'delete', label: t('chat.header.deleteRoutine'), danger: true },
    ]
    const picked = await showMenu(items, anchor)
    try {
      if (picked === 'edit') await call('pages', 'open', `atelier://routines/${routine.id}`)
      else if (picked === 'all') await call('pages', 'open', 'atelier://routines')
      else if (picked === 'toggle') await call('routines', 'save', { id: routine.id, name: routine.name, prompt: routine.prompt, schedule: routine.schedule, enabled: !routine.enabled })
      else if (picked === 'run') await call('routines', 'runNow', routine.id)
      else if (picked === 'delete') {
        const ok = await confirm({ title: t('chat.header.deleteTheRoutine', { name: routine.name }), message: t('chat.header.itStopsRunningChats'), destructive: true })
        if (ok) await call('routines', 'remove', routine.id)
      }
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }
  const label = routine ? routine.name : t('chat.header.routine')
  return (
    <button type="button" className={cx('chat-pill', routine && !routine.enabled && 'chat-pill--paused')} aria-haspopup="menu" title={routine ? t('chat.header.fromTheRoutine', { name: routine.name }) : deleted ? t('chat.header.fromARoutineThat') : t('chat.header.fromARoutine')} onClick={(e) => void open(e.currentTarget)}>
      {routine && !routine.enabled ? <Pause size={12} aria-hidden="true" /> : <CalendarClock size={12} aria-hidden="true" />}
      <span>{label}</span>
      {routine && !routine.enabled && <span className="chat-pill__state">{t('chat.header.paused')}</span>}
      {deleted && <span className="chat-pill__state">{t('chat.header.deleted')}</span>}
    </button>
  )
}

/** The tabs this chat acted on: switch to one, or close them all. */
export function TabsUsedButton({ state }: { state: ChatState }): ReactElement | null {
  const tabs = useTabs()
  const used = state.usedTabIds.flatMap((id) => tabs.tabs.filter((t) => t.id === id))
  if (used.length === 0) return null
  const open = async (anchor: Element): Promise<void> => {
    const items: MenuItemSpec[] = [
      ...used.map((t): MenuItemSpec => ({ id: `tab:${t.id}`, label: `${t.title || t.url}${state.tabIds.includes(t.id) ? ' (in use)' : ''}`, type: 'checkbox', checked: t.id === tabs.activeId })),
      menuSeparator(),
      { id: 'close-all', label: used.length === 1 ? t('chat.header.closeThisTab') : t('chat.header.closeTheseTabs', { length: used.length }), enabled: state.log.status === 'idle' },
    ]
    const picked = await showMenu(items, anchor)
    if (picked?.startsWith('tab:')) void atelier.tabs.activate(picked.slice(4))
    else if (picked === 'close-all') void call('chats', 'closeTabsUsed', state.summary?.id ?? '').catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' })) // CH-33
  }
  return (
    <button type="button" className="chat-pill" aria-haspopup="menu" title={t('chat.header.tabsThisChatUsed')} onClick={(e) => void open(e.currentTarget)}>
      <AppWindow size={12} aria-hidden="true" />
      <span>{t('chat.header.tabCount', { count: used.length })}</span>
    </button>
  )
}

export interface ChatMoreButtonProps {
  summary: ChatSummary
  hooks: ActionHooks
  label?: string
  /** DS-49/DS-65: offers "Move to the side panel" in the menu. */
  onCollapse?(): void
}

export function ChatMoreButton({ summary, hooks, label = t('chat.header.moreChatActions'), onCollapse }: ChatMoreButtonProps): ReactElement {
  return (
    <IconButton
      label={label}
      icon={<Ellipsis />}
      aria-haspopup="menu"
      onClick={(e) => {
        const anchor = e.currentTarget
        // CH-28: the chat files modal is in this menu too.
        const items = [
          ...chatMenu(summary, 'header'),
          menuSeparator(),
          ...(onCollapse ? [{ id: COLLAPSE_ITEM, label: t('chat.header.toPanel') }] : []),
          { id: CHAT_FILES_ITEM, label: t('files.chat.menuItem'), enabled: !summary.draft },
        ]
        void showMenu(items, anchor).then((picked) => {
          if (picked === CHAT_FILES_ITEM) showChatFiles(summary.id, anchor)
          else if (picked === COLLAPSE_ITEM) onCollapse?.()
          else void runChatAction(picked, [summary], hooks)
        })
      }}
    />
  )
}

/** The status word after the title while something is happening, from the chat's mood. */
export function statusWord(mood: CompanionMood, status: ChatState['log']['status']): { word: string; tone: 'working' | 'needs-input' } | null {
  if (status === 'awaiting-approval' || mood === 'approval') return { word: 'needs you', tone: 'needs-input' }
  if (status === 'idle') return null
  if (mood === 'working') return { word: 'working', tone: 'working' }
  if (mood === 'talking') return { word: 'writing', tone: 'working' }
  return { word: 'thinking', tone: 'working' }
}

export interface ChatChipProps {
  chatId: string
  state: ChatState
  companion: Companion | null | undefined
  mood: CompanionMood
  renaming: boolean
  onRenamingChange(renaming: boolean): void
  /** Shown in place of the title before the chat has loaded (the panel). */
  fallbackTitle?: string
  /** A status word to show instead of the mood's (the panel's "following the page"). */
  status?: string | null
}

/** DS-49/DS-64: the floating chip at the top-left: face, title (rename in place) and a status word. */
export function ChatChip({ chatId, state, companion, mood, renaming, onRenamingChange, fallbackTitle, status }: ChatChipProps): ReactElement {
  const shell = useShell()
  const summary = state.summary
  // CH-20: the header says what is happening in plain words, from the steps' kinds.
  const plain = activityStatus({ log: state.log, name: companion?.name ?? t('chat.header.yourCompanion'), paused: state.paused })
  const word = status !== undefined ? (status ? { word: status, tone: 'working' as const } : null) : plain ? { word: t(plain.key, plain.vars), tone: plain.tone === 'needs-input' ? ('needs-input' as const) : ('working' as const) } : statusWord(mood, state.log.status)
  return (
    <div className="chat-chip-header">
      <CompanionAvatar
        companion={companion}
        size={22}
        mood={mood}
        mark={state.log.status === 'awaiting-approval' ? 'approval' : null}
        label={companion ? `${companion.name}, open profile` : t('chat.header.thisChatSCompanion')}
        {...(companion ? { onClick: () => shell.openCompanionCard(companion.id, 'general') } : {})}
      />
      {summary ? (
        <ChatTitle chatId={chatId} summary={summary} editing={renaming} onEditingChange={onRenamingChange} className="chat-chip-header__title" />
      ) : (
        <span className="chat-chip-header__title">{fallbackTitle ?? t('chat.header.newChat')}</span>
      )}
      {word && (
        <span className={`chat-chip-header__status chat-chip-header__status--${word.tone}`} role="status">
          <span className="chat-chip-header__dot" aria-hidden="true" />
          {word.word}
        </span>
      )}
    </div>
  )
}

export interface ChatHeaderProps {
  chatId: string
  state: ChatState
  companion: Companion | null | undefined
  mood: CompanionMood
  hooks: Omit<ActionHooks, 'rename'>
  /** DS-65: move the chat back into the side panel beside its page. */
  onCollapse?(): void
}

/** The chat page's header: a floating chip at the top-left and quiet actions at the top-right, with no bar or divider. */
export function ChatHeader({ chatId, state, companion, mood, hooks, onCollapse }: ChatHeaderProps): ReactElement | null {
  const [renaming, setRenaming] = useState(false)
  const summary = state.summary
  if (!summary) return null
  return (
    <header className="chat-header">
      <ChatChip chatId={chatId} state={state} companion={companion} mood={mood} renaming={renaming} onRenamingChange={setRenaming} />
      <PrivateHeaderChip summary={summary} /* CH-30 */ />
      {/* DS-49: on the right only ⋯ and the details toggle. The routine, tabs used and files live in the
          details panel (DS-124); New chat and the move back into the side panel are in ⋯. */}
      <HeaderAside>
        <ChatMoreButton summary={summary} hooks={{ ...hooks, rename: () => setRenaming(true) }} {...(onCollapse ? { onCollapse } : {})} />
        <DetailsToggle chatId={chatId} /* CH-33: the details panel, with the routine and tabs used */ />
      </HeaderAside>
    </header>
  )
}

/**
 * DS-123: with the details panel open on a chat page, ⋯ and the toggle slide
 * past the header's end to the window's right edge, over the panel's empty
 * column. That spill is the design, so the layout audit leaves it out.
 */
function HeaderAside({ children }: { children: ReactNode }): ReactElement {
  const { open } = useDetailsStore()
  return (
    <div className="chat-header__aside" data-layout-ignore={open ? '' : undefined}>
      {children}
    </div>
  )
}
