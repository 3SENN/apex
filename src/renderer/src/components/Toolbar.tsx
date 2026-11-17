/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type MouseEvent, type ReactElement } from 'react'
import type { ChromeCommand, TabInfo, TabsSnapshot } from '@shared/ipc'
import type { DownloadInfo } from '@shared/services'
import { isBlankUrl, isInternalUrl, parseInternalUrl } from '@shared/url'
import { ChevronLeft, ChevronRight, Columns2, Menu, MessageSquareText, PanelLeft, RotateCw } from 'lucide-react'
import { atelier, call } from '../api'
import { IconButton, cx, showMenu } from '../ui'
import { AddressPill, openUniversalSearch, type AddressPillHandle } from './AddressPill'
import { DownloadsButton } from './sidebar/DownloadsButton'
import { navEnabled } from './toolbarLogic'
import { ActivityGlyph } from '../activity/ActivityGlyph'
import { SiteActions } from '../suggestions/SiteActions'
import { openMainMenu } from './sidebar/SidebarFooter'
import { t } from '../i18n/useT'
import { useSplitMenu } from './split'
import type { ShellMenuDeps } from './sidebar/shellMenu'
import { ChatPagesCluster } from '../chat/TabsUsed' // SH-32
import { ChatPagesControl } from '../chat/holdings/PagesControl' // CH-34
import { ArtifactStrip } from '../files/ArtifactStrip'
import { ExtensionsToolbar, extensionsSlot } from '../extensions/ExtensionsToolbar' // SH-32, SH-65
import { NowPlayingButton } from './media/NowPlayingButton' // media hub (MD-01)
import { EyeOff } from 'lucide-react'
import { useTooltip } from '../ui/Tooltip'

export interface ToolbarHandle {
  focusOmnibox(): void
}

interface ToolbarProps {
  tab: TabInfo | null
  snapshot: TabsSnapshot
  /** The sidebar toggle (sidebar layout only); while closed it carries a dot for chats that need you or are unread. */
  sidebarToggle: { open: boolean; dot: 'needs' | 'unread' | null } | null
  bookmarked: boolean
  showFullUrls: boolean
  /** Horizontal layout only: the sidebar header shows downloads otherwise. */
  downloads: DownloadInfo[] | null
  panelOpen: boolean
  /** The state the chat-about-this-page button carries. */
  agent: { working: boolean; approvals: number }
  onToggleSidebar(): void
  onTogglePanel(): void
  /** Horizontal layout: the main menu button (the sidebar has its footer instead). */
  menu: ShellMenuDeps | null
}

// SH-32: a private window says so; its tooltip says nothing from it is saved
function PrivateLabel(): ReactElement | null {
  const ref = useRef<HTMLSpanElement>(null)
  const isPrivate = atelier.initial.window.kind === 'private'
  useTooltip(ref, { label: t('core.privateWindow.label'), disabled: !isPrivate })
  if (!isPrivate) return null
  return (
    <span ref={ref} className="private-label" role="note" aria-label={t('core.privateWindow.label')}>
      <EyeOff size={13} strokeWidth={2} aria-hidden="true" />
      {t('core.privateWindow')}
    </span>
  )
}

/** Back or forward, with ⌘-click into a new tab and a long press or right-click for the history list. Inert on chat pages (DS-20). */
function HistoryButton({ tab, direction, quiet }: { tab: TabInfo | null; direction: 'back' | 'forward'; quiet: boolean }): ReactElement {
  const back = direction === 'back'
  const enabled = navEnabled(tab, direction, quiet)
  const list = async (anchor: HTMLElement): Promise<void> => {
    if (!tab || !enabled) return
    const entries = await call('tabs', 'history', tab.id, direction)
    if (entries.length === 0) return
    const id = await showMenu(entries.map((e) => ({ id: String(e.index), label: e.title || e.url })), anchor)
    if (id !== null) void call('tabs', 'goToIndex', tab.id, Number(id))
  }
  const go = async (e: MouseEvent): Promise<void> => {
    if (!tab || !enabled) return
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      const [next] = await call('tabs', 'history', tab.id, direction)
      if (next) void atelier.tabs.create(next.url, { afterId: tab.id, background: true })
      return
    }
    void (back ? atelier.nav.back(tab.id) : atelier.nav.forward(tab.id))
  }
  return (
    <IconButton
      label={back ? t('core.toolbar.back') : t('core.toolbar.forward')}
      shortcut={back ? 'CmdOrCtrl+[' : 'CmdOrCtrl+]'}
      tooltip={back ? t('core.toolbar.backHoldForHistory') : t('core.toolbar.forwardHoldForHistory')}
      className="history-btn"
      icon={back ? <ChevronLeft strokeWidth={1.5} /> : <ChevronRight strokeWidth={1.5} />}
      disabled={!enabled}
      onClick={(e) => void go(e)}
      onAuxClick={(e) => {
        if (e.button === 1) void go(e)
      }}
      onLongPress={(button) => void list(button)}
      onContextMenu={(e) => {
        e.preventDefault()
        void list(e.currentTarget)
      }}
    />
  )
}

/** Reload; while the page loads the glyph turns and a click stops it. Faded on chat pages. */
function ReloadButton({ tab, quiet }: { tab: TabInfo | null; quiet: boolean }): ReactElement {
  if (tab?.loading && !quiet) {
    return <IconButton label={t('core.toolbar.stopLoading')} shortcut="Escape" className="reload-btn reload-btn--loading" icon={<RotateCw />} onClick={() => void atelier.nav.stop(tab.id)} />
  }
  return (
    <IconButton
      label={t('core.toolbar.reload')}
      shortcut="CmdOrCtrl+R"
      tooltip={t('core.toolbar.reloadRShiftClick')}
      className="reload-btn"
      icon={<RotateCw />}
      disabled={!tab || quiet}
      onClick={(e) => {
        if (!tab) return
        if (e.metaKey || e.ctrlKey) void call('tabs', 'duplicate', tab.id)
        else void atelier.nav.reload(tab.id, e.shiftKey)
      }}
    />
  )
}

/** Only while the view is split (SH-32, DS-24): shows the focused side, and opens the split menu (SH-40). */
function SplitButton({ snapshot }: { snapshot: TabsSnapshot }): ReactElement | null {
  const menu = useSplitMenu(snapshot)
  const split = snapshot.split
  if (!split) return null
  const side = snapshot.activeId === split.secondaryId ? 'right' : 'left'
  return (
    <IconButton
      label={`${t('tabs.split.button')}, ${t(side === 'right' ? 'tabs.split.focusedRight' : 'tabs.split.focusedLeft')}`}
      tooltip={t('tabs.split.button')}
      aria-haspopup="menu"
      aria-expanded={menu.isOpen}
      className={cx('split-btn', `split-btn--${side}`)}
      icon={<Columns2 />}
      badge={<span className={cx('split-btn__side', `split-btn__side--${side}`)} aria-hidden />}
      onClick={(e) => menu.open(e.currentTarget)}
    />
  )
}

/** Websites only: chat about this page in the side panel (⌘J), with its working and approval state. */
function PageChatButton({ open, working, approvals, onClick }: { open: boolean; working: boolean; approvals: number; onClick(): void }): ReactElement {
  const state = approvals > 0 ? t('core.toolbar.waitingForYourApproval') : working ? ', working' : ''
  return (
    <IconButton
      label={`${open ? t('core.toolbar.hideTheChat') : t('core.toolbar.chatAboutThisPage')}${state}`}
      shortcut="CmdOrCtrl+J"
      tooltip={`${open ? t('core.toolbar.hideTheChat') : t('core.toolbar.chatAboutThisPage')} (⌘J)`}
      pressed={open}
      className="page-chat-btn"
      icon={<MessageSquareText />}
      badge={approvals > 0 ? <span className="page-chat-btn__state page-chat-btn__state--approval" aria-hidden /> : working ? <span className="page-chat-btn__state page-chat-btn__state--working" aria-hidden /> : undefined}
      onClick={onClick}
    />
  )
}

/**
 * The toolbar on the sheet: the sidebar toggle, back, forward and reload on
 * the left; the address pill centred on the sheet's midline; and a right
 * cluster that depends on the page: empty on chat and app pages, chat about
 * this page (and extension actions, later) on websites, the split button
 * only while split. The chat-beside-pages controls join after a
 * divider here.
 */
export const Toolbar = forwardRef<ToolbarHandle, ToolbarProps>(function Toolbar(props, ref) {
  const { tab, snapshot, sidebarToggle, agent } = props
  const pill = useRef<AddressPillHandle>(null)
  const bar = useRef<HTMLDivElement>(null)
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focusOmnibox: () => pill.current?.edit() }))

  // ⌘D's editor, ⇧⌘A's universal search, the command bar
  useEffect(
    () =>
      atelier.onCommand((received) => {
        // 'ui:command' carries ChromeCommands; the preload's type is still the older, narrower one.
        const command = received as ChromeCommand
        if (command === 'bookmark-editor') pill.current?.bookmark()
        else if (command === 'open-universal-search') openUniversalSearch()
        else if (command === 'open-command-bar') pill.current?.edit()
      }),
    [],
  )

  const url = tab?.url ?? ''
  const website = tab !== null && !isInternalUrl(url) && !isBlankUrl(url)
  const onChatPage = parseInternalUrl(url)?.page === 'chat'

  // The pill shrinks to clear the wider cluster on both sides, so it stays on the midline.
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const measure = (): void => {
      const side = Math.max(left.current?.offsetWidth ?? 0, right.current?.offsetWidth ?? 0) + 10
      el.style.setProperty('--toolbar-side', `${side}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (left.current) observer.observe(left.current)
    if (right.current) observer.observe(right.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={bar} className="toolbar">
      <div ref={left} className="toolbar__group toolbar__group--nav">
        {sidebarToggle && (
          <IconButton
            label={sidebarToggle.open ? t('core.toolbar.hideSidebar') : t('core.toolbar.showSidebar')}
            shortcut="CmdOrCtrl+S"
            className="sidebar-toggle"
            icon={<PanelLeft />}
            badge={!sidebarToggle.open && sidebarToggle.dot ? <span className={cx('toggle-dot', sidebarToggle.dot === 'needs' && 'toggle-dot--needs')} aria-label={sidebarToggle.dot === 'needs' ? t('core.toolbar.aChatNeedsYou') : t('core.toolbar.unreadChats')} /> : undefined}
            onClick={props.onToggleSidebar}
          />
        )}
        <HistoryButton tab={tab} direction="back" quiet={onChatPage} />
        <HistoryButton tab={tab} direction="forward" quiet={onChatPage} />
        <ReloadButton tab={tab} quiet={onChatPage} />
      </div>

      <div className="toolbar__center">
        <AddressPill ref={pill} tab={tab} bookmarked={props.bookmarked} showFullUrls={props.showFullUrls} />
      </div>

      <div ref={right} className="toolbar__group">
        <PrivateLabel />
        {/* OV-24, DS-24; hidden while activity memory is off */}
        <ActivityGlyph visible={website} />
        {/* OV-23 */}
        <SiteActions tab={tab} website={website} />
        {/* MD-01: what's playing in this window's tabs, while anything is. */}
        <NowPlayingButton />
        {props.downloads && <DownloadsButton downloads={props.downloads} size="md" />}
        <SplitButton snapshot={snapshot} />
        {/* SH-32, CH-33: divider, the pages beside a chat, expand, hide */}
        <ChatPagesCluster snapshot={snapshot} />
        {/* CH-34 */}
        <ChatPagesControl snapshot={snapshot} />
        <ArtifactStrip tab={tab} />
        {website && <PageChatButton open={props.panelOpen} working={agent.working} approvals={agent.approvals} onClick={props.onTogglePanel} />}
        {/* SH-32, SH-65: pinned actions and the Extensions button; utility pages keep only the button */}
        <ExtensionsToolbar slot={tab ? extensionsSlot(url) : null} />
        {props.menu && <IconButton label={t('core.toolbar.menu')} aria-haspopup="menu" icon={<Menu />} onClick={(e) => props.menu && void openMainMenu(e.currentTarget, props.menu)} />}
      </div>
    </div>
  )
})
