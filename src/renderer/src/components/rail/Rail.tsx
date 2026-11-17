/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import type { ChatSummary } from '@shared/chats'
import type { SettingsView, TabsSnapshot } from '@shared/ipc'
import type { Bookmark, Routine } from '@shared/services'
import { DESTINATIONS, chatUrl, parseInternalUrl, type Destination } from '@shared/url'
import { PanelLeftClose, PanelLeftOpen, SquarePen, X } from 'lucide-react'
import { call } from '../../api'
import { t } from '../../i18n/useT'
import { IconButton, Seam, cx, isMac } from '../../ui'
import { useCompanions, useShell } from '../shellContext'
import { startNewChatPage } from '../sidebar/ChatsSection'
import { CompanionAvatarById } from '../sidebar/CompanionAvatar'
import { Destinations } from '../sidebar/Destinations'
import { chatCounts } from '../sidebar/logic/menus'
import { SidebarFooter } from '../sidebar/SidebarFooter'
import { RAIL_COLLAPSED_WIDTH, RAIL_PREFS_KEY, RAIL_STEP, RAIL_WIDTH, clampRailWidth, parseRailPrefs, recentChats, type RailPrefs } from './logic'
import './rail.css'

// The navigation rail (SH-63): in the horizontal layout, apex:// pages get a
// left column with New Chat, the destinations with their live badges, the
// recent chats and the profile menu. ⌘S collapses it to icons and back; its
// edge resizes by drag or with ←/→ in 8 px steps; a one-time hint points
// both out. The collapsed state, width and hint are kept per viewer.

export interface RailProps {
  snapshot: TabsSnapshot
  chats: ChatSummary[] | null
  routines: Routine[]
  settings: SettingsView
  bookmarks: Bookmark[]
}

function loadPrefs(): RailPrefs {
  try {
    return parseRailPrefs(window.localStorage.getItem(RAIL_PREFS_KEY))
  } catch {
    return parseRailPrefs(null)
  }
}

function savePrefs(prefs: RailPrefs): void {
  try {
    window.localStorage.setItem(RAIL_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage can be off (private windows); the rail still works for this session.
  }
}

export function Rail({ snapshot, chats, routines, settings, bookmarks }: RailProps): ReactElement {
  const shell = useShell()
  const { activeId: companionId } = useCompanions()
  const [prefs, setPrefs] = useState(loadPrefs)
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  const update = (patch: Partial<RailPrefs>): void =>
    setPrefs((p) => {
      const next = { ...p, ...patch }
      savePrefs(next)
      return next
    })
  const collapsed = prefs.collapsed
  const toggle = (): void => update({ collapsed: !collapsed, hintSeen: true })

  // ⌘S: apex:// pages draw in the chrome, so the key reaches it here (pages on the web never see it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const railRoute = snapshot.rail ? parseInternalUrl(snapshot.rail.url) : null
  const current = railRoute && (DESTINATIONS as readonly string[]).includes(railRoute.page) ? (railRoute.page as Destination) : null
  const counts = chatCounts(chats ?? [])
  const recent = recentChats(chats)
  const width = collapsed ? RAIL_COLLAPSED_WIDTH : (liveWidth ?? prefs.width)
  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId)
  const activeChat = activeTab ? parseInternalUrl(activeTab.url) : null

  return (
    <nav className={cx('rail', collapsed && 'rail--collapsed', liveWidth !== null && 'rail--resizing')} style={{ width }} aria-label={t('tabs.rail.label')} id="apex-rail">
      <div className="rail__head">
        <button type="button" className="rail__new" onClick={() => void startNewChatPage(snapshot, companionId)} title={collapsed ? t('tabs.rail.newChat') : undefined}>
          <SquarePen size={16} aria-hidden />
          {!collapsed && <span>{t('tabs.rail.newChat')}</span>}
        </button>
        <IconButton size="sm" label={collapsed ? t('tabs.rail.expand') : t('tabs.rail.collapse')} shortcut="CmdOrCtrl+S" icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />} aria-expanded={!collapsed} aria-controls="apex-rail" onClick={toggle} />
      </div>
      <div className="rail__body">
        <Destinations
          options={settings.sidebar}
          current={current}
          activeTabId={snapshot.rail ? 'rail' : snapshot.activeId}
          unread={counts.unread}
          needsInput={counts.needsInput}
          routines={routines}
          routineUnread={(chats ?? []).some((c) => c.routineId !== null && c.unread)}
          arrival={null}
          focusId={null}
          onOpenOptions={() => void call('pages', 'open', 'apex://settings/appearance')}
          onReset={shell.remountPage}
        />
        {recent.length > 0 && (
          <section className="rail__recent" aria-label={t('tabs.rail.recent')}>
            {!collapsed && <div className="rail__label">{t('tabs.rail.recent')}</div>}
            {recent.map((chat) => {
              const here = activeChat?.page === 'chat' && 'id' in activeChat && activeChat.id === chat.id
              return (
                <button key={chat.id} type="button" className={cx('rail__chat', here && 'rail__chat--active')} aria-current={here ? 'page' : undefined} title={chat.title || t('core.rail.newChat')} onClick={() => void call('pages', 'open', chatUrl(chat.id))}>
                  <CompanionAvatarById id={chat.companionId} size={18} label="" />
                  {!collapsed && <span className="rail__chat-title">{chat.title || t('core.rail.newChat')}</span>}
                </button>
              )
            })}
          </section>
        )}
      </div>
      {!prefs.hintSeen && !collapsed && (
        <div className="rail__hint" role="note">
          <span>{t('tabs.rail.hint')}</span>
          <button type="button" className="rail__hint-dismiss" onClick={() => update({ hintSeen: true })}>
            {t('tabs.rail.hintDismiss')}
          </button>
          <IconButton size="sm" label={t('tabs.rail.hintDismiss')} icon={<X />} onClick={() => update({ hintSeen: true })} className="rail__hint-close" />
        </div>
      )}
      <SidebarFooter deps={{ snapshot, settings, bookmarks, sidebarOpen: false }} />
      {!collapsed && (
        <Seam
          className="rail__seam ui-seam--bare"
          label={t('tabs.rail.resize')}
          value={liveWidth ?? prefs.width}
          min={RAIL_WIDTH.min}
          max={RAIL_WIDTH.max}
          step={RAIL_STEP}
          resetTo={RAIL_WIDTH.default}
          controls="apex-rail"
          valueText={(v) => t('core.rail.pixelsWide', { value: Math.round(v) })}
          onChange={(v) => setLiveWidth(clampRailWidth(v))}
          onCommit={(v) => {
            setLiveWidth(null)
            update({ width: clampRailWidth(v), hintSeen: true })
          }}
          onDragChange={(dragging) => {
            if (!dragging) setLiveWidth(null)
          }}
        />
      )}
    </nav>
  )
}
