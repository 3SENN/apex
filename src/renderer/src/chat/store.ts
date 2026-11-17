/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useSyncExternalStore } from 'react'
import type { ChatFeedback, ChatSetup, ChatSummary, ChatView, MessageDetails, QueuedMessage } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { foldAgentLog, type AgentLog } from '../agentLog'
import { apex, call, errorText } from '../api'
import { REVEAL_BATCH_MS, advanceReveal, newReveal, type RevealRecord } from './logic/reveal'
import { LOADING_LOG, applyView, beginLoad, receiveEvent, type LiveLog } from './logic/sync'
import { isStopNotice } from './logic/view'

// One controller per chat a surface shows. The side panel and a chat page
// showing the same chat share it, so the second one mirrors the first
// exactly. Controllers follow agent and app events from one subscription.

export type ChatPhase = 'loading' | 'ready' | 'missing' | 'failed'

export interface ChatState {
  phase: ChatPhase
  /** Why loading failed (phase 'failed'). */
  error: string | null
  summary: ChatSummary | null
  setup: ChatSetup | null
  log: AgentLog
  details: Record<string, MessageDetails>
  feedback: Record<string, ChatFeedback>
  queued: QueuedMessage[]
  tabIds: string[]
  usedTabIds: string[]
  /** Counts streamed text chunks, for the companion's mouth. */
  talk: number
  activity: 'text' | 'thinking' | 'tool' | null
  activityAt: number
  outcome: 'ok' | 'error' | null
  outcomeAt: number
  /** When the current run started (or a message was just sent); null while idle. */
  runStartedAt: number | null
  /** A send is on its way: the pending line shows before main confirms the run. */
  sentAt: number | null
  /** How long each finished run took, by the message it answered (this session only). */
  durations: Record<string, number>
  /** The file could not be migrated, or a newer Apex saved it (ChatView.notice). */
  notice?: ChatView['notice']
  // CH-13 paging, SS-05 save failures, the paused run, SS-03's live error
  /** Index of the first loaded log event in the saved log; above 0, older pages can load. */
  logStart?: number
  olderLoading?: boolean
  olderError?: string | null
  /** The chat's last save failed (SS-05). */
  saveError?: string | null
  /** The run waits at a safe point (the shield's pause, a take-over). */
  paused?: boolean
  /** When an error arrived live in this session, for the auto-retry countdown; null otherwise. */
  liveErrorAt?: number | null
}

const INITIAL: ChatState = {
  phase: 'loading',
  error: null,
  summary: null,
  setup: null,
  log: LOADING_LOG.log,
  details: {},
  feedback: {},
  queued: [],
  tabIds: [],
  usedTabIds: [],
  talk: 0,
  activity: null,
  activityAt: 0,
  outcome: null,
  outcomeAt: 0,
  runStartedAt: null,
  sentAt: null,
  durations: {},
}

/** A sent message that main never confirms stops showing as pending after this long. */
const SENT_TIMEOUT_MS = 12_000

// Run durations outlive a controller (it is dropped a while after its views
// close), so reopening a chat in this session still shows "Took 2 min".
const durationsByChat = new Map<string, Record<string, number>>()

/** Where a view left a chat's scroll: px from the bottom, or null at the bottom. */
const scrollByChat = new Map<string, number | null>()

const MISSING = /no longer exists/i
/** CH-13: events per older page. */
const OLDER_LIMIT = 200
/** Released controllers linger this long, so remounts and quick switches don't reload. */
const LINGER_MS = 15_000

class ChatController {
  readonly id: string
  state: ChatState = INITIAL
  refs = 0
  #live: LiveLog = LOADING_LOG
  #listeners = new Set<() => void>()
  #runFailed = false
  #metaTimer: ReturnType<typeof setTimeout> | null = null
  #lingerTimer: ReturnType<typeof setTimeout> | null = null
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #sentTimer: ReturnType<typeof setTimeout> | null = null
  #pendingPatch: Partial<ChatState> | null = null
  #loads = 0
  /** Word-reveal records per text turn; only turns that streamed in while watched get one at first. */
  readonly reveal = new Map<string, RevealRecord>()
  #streamed = new Set<string>()
  /** CH-13: the raw events behind the log, so an older page can be folded in front of them. */
  #events: AgentEvent[] = []

  constructor(id: string) {
    this.id = id
    void this.load()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #set(patch: Partial<ChatState>): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = null
    }
    const merged = this.#pendingPatch ? { ...this.#pendingPatch, ...patch } : patch
    this.#pendingPatch = null
    this.state = { ...this.state, ...merged }
    for (const listener of this.#listeners) listener()
  }

  /** Streamed text reaches views a few times a second, so words arrive in small batches. */
  #setBatched(patch: Partial<ChatState>): void {
    this.#pendingPatch = this.#pendingPatch ? { ...this.#pendingPatch, ...patch } : patch
    this.#flushTimer ??= setTimeout(() => {
      this.#flushTimer = null
      this.#set({})
    }, REVEAL_BATCH_MS)
  }

  /** Loads (or reloads) the whole view; live events that arrive meanwhile are kept. */
  async load(): Promise<void> {
    const attempt = ++this.#loads
    this.#live = beginLoad(this.#live)
    if (this.state.phase !== 'ready') this.#set({ phase: 'loading', error: null })
    try {
      const view = await call('chats', 'get', this.id)
      if (attempt !== this.#loads) return
      this.#events = [...view.log, ...(this.#live.pending ?? []).filter((p) => p.seq > view.seq).map((p) => p.event)]
      this.#live = applyView(this.#live, view)
      const live = view.agentStatus !== 'idle'
      this.#set({
        runStartedAt: live ? (this.state.runStartedAt ?? Date.now()) : null,
        durations: durationsByChat.get(this.id) ?? {},
        phase: 'ready',
        error: null,
        summary: view.summary,
        setup: view.setup,
        log: this.#live.log,
        details: view.details,
        feedback: view.feedback,
        queued: view.queued,
        tabIds: view.tabIds,
        usedTabIds: view.usedTabIds,
        notice: view.notice ?? null,
        logStart: view.logStart ?? 0,
        olderError: null,
        saveError: view.saveError ?? null,
        paused: view.paused ?? false,
      })
    } catch (err) {
      if (attempt !== this.#loads) return
      const message = errorText(err)
      if (MISSING.test(message)) {
        this.#live = { ...this.#live, pending: null }
        this.#set({ phase: 'missing', error: null })
      } else {
        this.#set({ phase: 'failed', error: message })
      }
    }
  }

  /** Refreshes everything but the log (details and setup only change when a run starts or ends). */
  #refreshMeta(): void {
    if (this.#metaTimer) clearTimeout(this.#metaTimer)
    this.#metaTimer = setTimeout(() => {
      this.#metaTimer = null
      call('chats', 'get', this.id).then(
        (view) => this.#set({ summary: view.summary, setup: view.setup, details: view.details, feedback: view.feedback, queued: view.queued, tabIds: view.tabIds, usedTabIds: view.usedTabIds }),
        () => undefined,
      )
    }, 120)
  }

  agentEvent(event: AgentEvent, seq: number): void {
    if (this.state.phase === 'missing') return
    const wasRunning = this.#live.log.status !== 'idle'
    const seenSeq = this.#live.seq
    this.#live = receiveEvent(this.#live, event, seq)
    if (this.#live.pending) return
    // CH-13: keep the raw events; a reset starts the history over.
    if (this.#live.seq !== seenSeq) {
      if (event.type === 'reset') this.#events = []
      else this.#events.push(event)
    }
    const patch: Partial<ChatState> = { log: this.#live.log }
    const now = Date.now()
    switch (event.type) {
      case 'text-delta':
        this.#streamed.add(event.turnId)
        this.#setBatched({ log: this.#live.log, talk: (this.#pendingPatch?.talk ?? this.state.talk) + 1, activity: 'text', activityAt: now })
        return
      case 'thinking-delta':
        this.#setBatched({ log: this.#live.log, activity: 'thinking', activityAt: now })
        return
      case 'tool':
        patch.activity = event.state === 'running' ? 'tool' : 'thinking'
        patch.activityAt = now
        break
      case 'error':
        if (!isStopNotice(event.message)) this.#runFailed = true
        patch.liveErrorAt = now // SS-03
        break
      case 'status':
        if (event.status !== 'idle' && !wasRunning) {
          this.#runFailed = false
          patch.outcome = null
          patch.activity = null
          patch.runStartedAt = this.state.sentAt ?? now
          patch.sentAt = null
          patch.liveErrorAt = null
        } else if (event.status === 'idle' && wasRunning) {
          patch.outcome = this.#runFailed ? 'error' : 'ok'
          patch.outcomeAt = now
          patch.activity = null
          patch.runStartedAt = null
          patch.sentAt = null
          const started = this.state.runStartedAt
          const answered = lastUserId(this.#live.log.items)
          if (started !== null && answered) {
            const durations = { ...this.state.durations, [answered]: now - started }
            durationsByChat.set(this.id, durations)
            patch.durations = durations
          }
        }
        this.#refreshMeta()
        break
      case 'reset':
        patch.details = {}
        patch.feedback = {}
        patch.logStart = 0
        this.#refreshMeta()
        break
      default:
        break
    }
    this.#set(patch)
  }

  appEvent(event: AppEvent): void {
    if (event.type === 'chats') {
      const summary = event.items.find((c) => c.id === this.id)
      if (summary) {
        if (JSON.stringify(summary) !== JSON.stringify(this.state.summary)) this.#set({ summary })
      } else if (this.state.phase === 'ready' && this.state.summary && !this.state.summary.draft) {
        // A saved chat left the full list: it was deleted.
        this.#set({ phase: 'missing' })
      }
    } else if (event.type === 'chat-queue' && event.chatId === this.id) {
      this.#set({ queued: event.queued })
    } else if (event.type === 'chat-tabs') {
      const tabIds = Object.entries(event.owners).flatMap(([tabId, chatId]) => (chatId === this.id ? [tabId] : []))
      const usedTabIds = [...new Set([...this.state.usedTabIds, ...tabIds])]
      this.#set({ tabIds, usedTabIds })
    }
    // SS-05 save state; the run paused or going again
    else if (event.type === 'chat-save-state' && event.chatId === this.id) {
      this.#set({ saveError: event.error })
    } else if (event.type === 'agent-control' && event.chatId === this.id) {
      const paused = event.state === 'paused' || event.state === 'taken-over'
      if (paused !== (this.state.paused ?? false)) this.#set({ paused })
    }
  }

  // CH-13
  /** Folds the page before the loaded log in front of it. Resolves false when there was nothing to load. */
  async loadOlder(): Promise<boolean> {
    const start = this.state.logStart ?? 0
    if (start <= 0 || this.state.olderLoading || this.state.phase !== 'ready') return false
    this.#set({ olderLoading: true, olderError: null })
    try {
      const page = await call('chats', 'older', this.id, start, OLDER_LIMIT)
      // A reload or reset meanwhile already replaced the log.
      if ((this.state.logStart ?? 0) !== start) return false
      this.#events = [...page.events, ...this.#events]
      const log = { ...foldAgentLog(this.#events, this.#live.log.status), interrupting: this.#live.log.interrupting ?? false }
      this.#live = { ...this.#live, log }
      this.#set({ log, logStart: page.hasOlder ? Math.max(1, start - page.events.length) : 0, olderLoading: false })
      return page.events.length > 0
    } catch (err) {
      this.#set({ olderLoading: false, olderError: errorText(err) })
      return false
    }
  }

  /** Local updates after a successful call, before main's events confirm them. */
  patch(patch: Partial<Pick<ChatState, 'summary' | 'feedback' | 'queued'>>): void {
    this.#set(patch)
  }

  /** A message is on its way: show the pending line now, not when main answers. */
  markSent(sending: boolean): void {
    if (this.#sentTimer) clearTimeout(this.#sentTimer)
    this.#sentTimer = null
    if (!sending) {
      if (this.state.sentAt !== null && this.#live.log.status === 'idle') this.#set({ sentAt: null })
      return
    }
    if (this.#live.log.status !== 'idle') return
    this.#set({ sentAt: Date.now() })
    this.#sentTimer = setTimeout(() => {
      this.#sentTimer = null
      if (this.state.sentAt !== null && this.#live.log.status === 'idle') this.#set({ sentAt: null })
    }, SENT_TIMEOUT_MS)
  }

  /** The reveal record for one text turn, created on first sight (settled unless it streamed in here). */
  revealFor(turnId: string, words: number, now: number): RevealRecord {
    const known = this.reveal.get(turnId)
    const next = known ? advanceReveal(known, words, now) : newReveal(words, this.#streamed.has(turnId), now)
    if (next !== known) this.reveal.set(turnId, next)
    return next
  }

  retain(): void {
    this.refs++
    if (this.#lingerTimer) clearTimeout(this.#lingerTimer)
    this.#lingerTimer = null
  }

  release(): void {
    this.refs = Math.max(0, this.refs - 1)
    this.linger()
  }

  linger(): void {
    if (this.refs > 0 || this.#lingerTimer) return
    this.#lingerTimer = setTimeout(() => {
      this.#lingerTimer = null
      if (this.refs === 0) controllers.delete(this.id)
    }, LINGER_MS)
  }
}

function lastUserId(items: readonly { kind: string; id: string }[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.kind === 'user') return items[i]?.id ?? null
  return null
}

const controllers = new Map<string, ChatController>()
let subscribed = false

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  // The chrome lives as long as these subscriptions, so they are never removed.
  apex.agent.onEvent((event, meta) => controllers.get(meta.chatId)?.agentEvent(event, meta.seq))
  apex.onAppEvent((event) => {
    if (event.type !== 'chats' && event.type !== 'chat-queue' && event.type !== 'chat-tabs' && event.type !== 'chat-save-state' && event.type !== 'agent-control') return
    for (const controller of controllers.values()) controller.appEvent(event)
  })
}

function controllerFor(id: string): ChatController {
  subscribeOnce()
  let controller = controllers.get(id)
  if (!controller) {
    controller = new ChatController(id)
    controllers.set(id, controller)
    // Created during render; dropped again if no effect ever retains it.
    controller.linger()
  }
  return controller
}

const NO_CHAT = { subscribe: () => () => undefined, snapshot: (): ChatState => INITIAL }

/** Follows one chat: its log, summary, setup, queue and tabs. */
export function useChat(chatId: string | null): ChatState {
  const controller = chatId ? controllerFor(chatId) : null
  useEffect(() => {
    if (!controller) return
    controller.retain()
    // A remount (⌘R on the page) is a chance to try a failed load again.
    if (controller.state.phase === 'failed') void controller.load()
    return () => controller.release()
  }, [controller])
  return useSyncExternalStore(controller?.subscribe ?? NO_CHAT.subscribe, () => controller?.state ?? NO_CHAT.snapshot())
}

export function reloadChat(chatId: string): void {
  void controllers.get(chatId)?.load()
}

export function patchChat(chatId: string, patch: Partial<Pick<ChatState, 'summary' | 'feedback' | 'queued'>>): void {
  controllers.get(chatId)?.patch(patch)
}


/** Shows the pending line at once when a message goes out (false: the send failed). */
export function markSent(chatId: string, sending = true): void {
  controllers.get(chatId)?.markSent(sending)
}

/** The word-reveal record for a text turn (see logic/reveal.ts). */
export function revealRecord(chatId: string, turnId: string, words: number, now: number): RevealRecord {
  const controller = controllers.get(chatId)
  return controller ? controller.revealFor(turnId, words, now) : { shown: words, batches: [] }
}

/** Remembers where a view left the chat's scroll, so the next view (the page after expand) picks up there. */
export function saveScroll(chatId: string, fromBottom: number | null): void {
  scrollByChat.set(chatId, fromBottom)
}

export function savedScroll(chatId: string): number | null {
  return scrollByChat.get(chatId) ?? null
}

/** CH-13: loads the page of the log before the loaded one. */
export function loadOlder(chatId: string): Promise<boolean> {
  return controllers.get(chatId)?.loadOlder() ?? Promise.resolve(false)
}

/** The chat's current state outside React (the request tray, keyboard handlers). */
export function chatState(chatId: string): ChatState | null {
  return controllers.get(chatId)?.state ?? null
}
