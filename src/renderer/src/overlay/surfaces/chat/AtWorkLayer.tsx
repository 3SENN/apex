/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { noticeAnchorRect, pillState, shieldShown, type AgentControlView, type PillChat } from '@shared/agentControl'
import type { OverlayResult, SurfaceAnchor } from '@shared/overlay'
import { DEFAULT_LOOK } from '@shared/companion'
import { t } from '@shared/i18n/core'
import type { AtWorkCompanion } from '@shared/overlay/chat'
import { chatUrl, parseInternalUrl } from '@shared/url'
import { call, useAppEvent } from '../../../api'
import { useChatList, useTabs } from '../../../chat/hooks'
import { pushQuote } from '../../../chat/quoteInbox'
import { useCompanions } from '../../../components/shellContext'
import { useSurface } from '../../useSurface'

// The chrome's side of the agent at work. It follows main's
// control views and opens, per controlled tab of this window, the shield
// (while the agent drives) and the notice (OV-21, OV-22); the status pill
// while the panel is closed and a chat works or needs you; and it
// answers main's `chat-open` (the notice's Open chat and side by side, the
// selection chip's Ask and Explain, ⌘J with a selection).
// Before the overlay host is up an open is refused quietly; nothing is ever
// drawn inside the page itself.

export interface AtWorkLayerProps {
  panelOpen: boolean
  activeTabId: string | null
  openPanel(chatId?: string | null): void
  closePanel(): void
}

/** Re-opens a surface that was dismissed from under us (Escape, an overlay crash), at most a few times. */
const REOPEN_LIMIT = 3

function useControlViews(): Map<string, AgentControlView> {
  const [views, setViews] = useState<Map<string, AgentControlView>>(() => new Map())
  useEffect(() => {
    let live = true
    call('agent', 'controlStates').then(
      (list) => live && setViews((current) => (current.size > 0 ? current : new Map(list.map((v) => [v.tabId, v])))),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  useAppEvent('agent-control-view', (e) => {
    setViews((current) => {
      const next = new Map(current)
      if (e.view) next.set(e.tabId, e.view)
      else next.delete(e.tabId)
      return next
    })
  })
  return views
}

function useCursors(): Map<string, { x: number; y: number }> {
  const [cursors, setCursors] = useState<Map<string, { x: number; y: number }>>(() => new Map())
  useAppEvent('agent-cursor', (e) => setCursors((current) => new Map(current).set(e.tabId, { x: e.x, y: e.y })))
  return cursors
}

function companionFor(list: ReturnType<typeof useCompanions>['list'], id: string): AtWorkCompanion {
  const c = list.find((x) => x.id === id) ?? list[0]
  const raw = c?.look.colors.accent ?? DEFAULT_LOOK.colors.accent
  const accent = /^#[0-9a-f]{6}$/i.test(raw) ? raw : DEFAULT_LOOK.colors.accent
  return { id: c?.id ?? id, name: c?.name ?? t('atWork.companion.fallbackName'), accent, glow: accent }
}

function ShieldSurface({ view, companion, cursor, onLost }: { view: AgentControlView; companion: AtWorkCompanion; cursor: { x: number; y: number } | null; onLost(r: OverlayResult): void }): null {
  const anchor = useMemo<SurfaceAnchor>(() => ({ kind: 'tab', tabId: view.tabId, rect: null }), [view.tabId])
  const props = useMemo(() => ({ tabId: view.tabId, state: view.state, companion, cursor }), [view.tabId, view.state, companion, cursor])
  useSurface('agent-shield', { open: true, anchor, props, onResult: onLost })
  return null
}

function NoticeSurface({ view, companion, beside, onLost }: { view: AgentControlView; companion: AtWorkCompanion; beside: boolean; onLost(r: OverlayResult): void }): null {
  // The anchor is fixed for this mount; a moved notice remounts with the new spot (see the key below).
  const anchor = useMemo<SurfaceAnchor>(() => ({ kind: 'tab', tabId: view.tabId, rect: noticeAnchorRect(view.position) }), [view.tabId, view.position])
  const props = useMemo(
    () => ({ tabId: view.tabId, chatId: view.chatId, state: view.state, activity: view.activity, companion, position: view.position, solvedAt: view.solvedAt, nudge: view.nudge, beside }),
    [view, companion, beside],
  )
  useSurface('agent-notice', { open: true, anchor, props, onResult: onLost })
  return null
}

/** The pill sits under the toolbar's chat button, or at the toolbar's right end where there is none. */
function pillAnchor(): SurfaceAnchor | null {
  const button = document.querySelector<HTMLElement>('.page-chat-btn')
  if (button) {
    const r = button.getBoundingClientRect()
    return { kind: 'window', rect: { x: r.left, y: r.top, width: r.width, height: r.height } }
  }
  const bar = document.querySelector<HTMLElement>('.toolbar')
  if (!bar) return null
  const r = bar.getBoundingClientRect()
  return { kind: 'window', rect: { x: r.right - 40, y: r.top, width: 32, height: r.height } }
}

function PillSurface({ chatId, mode, companion, label, others, onOpen }: { chatId: string; mode: 'working' | 'approval'; companion: AtWorkCompanion; label: string; others: number; onOpen(chatId: string): void }): null {
  const [anchor] = useState<SurfaceAnchor | null>(pillAnchor)
  const props = useMemo(() => ({ chatId, mode, companion, label, others }), [chatId, mode, companion, label, others])
  useSurface('agent-pill', {
    open: anchor !== null,
    anchor: anchor ?? { kind: 'point', x: 0, y: 0 },
    props,
    onResult: (r) => {
      if ('value' in r && r.value === 'open') onOpen(chatId)
    },
  })
  return null
}

export function AtWorkLayer({ panelOpen, activeTabId, openPanel, closePanel }: AtWorkLayerProps): ReactElement {
  const views = useControlViews()
  const cursors = useCursors()
  const { list: companions } = useCompanions()
  const chats = useChatList()
  const tabs = useTabs()
  const [reopened, setReopened] = useState<Record<string, number>>({})

  // useAppEvent keeps its first listener, so the panel's state is read through a ref.
  const panel = useRef({ panelOpen, openPanel, closePanel })
  panel.current = { panelOpen, openPanel, closePanel }
  useAppEvent('chat-open', (e) => {
    const { panelOpen: open, openPanel: show, closePanel: hide } = panel.current
    if (e.where === 'page' && e.chatId) {
      void call('pages', 'open', chatUrl(e.chatId))
      return
    }
    if (e.toggle && open) {
      hide()
      return
    }
    show(e.chatId)
    if (e.quote) pushQuote(e.quote)
  })

  const lost = (key: string) => (r: OverlayResult): void => {
    if (!('dismissed' in r) || (r.dismissed !== 'escape' && r.dismissed !== 'crashed')) return
    setReopened((n) => ((n[key] ?? 0) >= REOPEN_LIMIT ? n : { ...n, [key]: (n[key] ?? 0) + 1 }))
  }

  // The tabs of this window the agent holds.
  const ours = useMemo(() => new Set(tabs.tabs.map((t) => t.id)), [tabs])
  const held = [...views.values()].filter((v) => ours.has(v.tabId) && v.state !== 'idle')
  const companionOf = useMemo(() => {
    const cache = new Map<string, AtWorkCompanion>()
    return (id: string): AtWorkCompanion => {
      let c = cache.get(id)
      if (!c) {
        c = companionFor(companions, id)
        cache.set(id, c)
      }
      return c
    }
  }, [companions])

  // The pill, while the panel is closed. A chat shown as the page you're on, and routine runs, don't count.
  const shownChat = (() => {
    const tab = tabs.tabs.find((t) => t.id === activeTabId)
    const route = tab ? parseInternalUrl(tab.url) : null
    return route?.page === 'chat' ? route.id : null
  })()
  const pillChats: PillChat[] = (chats ?? [])
    .filter((c) => !c.routineId && !c.draft && c.id !== shownChat)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .map((c) => ({ id: c.id, companionId: c.companionId, status: c.status, title: c.title }))
  const pill = pillState(pillChats, panelOpen)
  const pillView = pill ? [...views.values()].find((v) => v.chatId === pill.chatId) : undefined

  return (
    <>
      {held.map((view) =>
        shieldShown(view.state) ? (
          <ShieldSurface key={`shield:${view.tabId}:${reopened[`shield:${view.tabId}`] ?? 0}`} view={view} companion={companionOf(view.companionId)} cursor={cursors.get(view.tabId) ?? null} onLost={lost(`shield:${view.tabId}`)} />
        ) : null,
      )}
      {held.map((view) => (
        <NoticeSurface
          key={`notice:${view.tabId}:${view.position ? `${view.position.x},${view.position.y}` : 'top'}:${reopened[`notice:${view.tabId}`] ?? 0}`}
          view={view}
          companion={companionOf(view.companionId)}
          beside={panelOpen}
          onLost={lost(`notice:${view.tabId}`)}
        />
      ))}
      {pill && (
        <PillSurface
          key={`pill:${activeTabId ?? ''}:${pill.chatId}`}
          chatId={pill.chatId}
          mode={pill.mode}
          companion={companionOf(pill.companionId)}
          label={pillView?.activity ?? ''}
          others={pill.others}
          onOpen={(id) => openPanel(id)}
        />
      )}
    </>
  )
}
