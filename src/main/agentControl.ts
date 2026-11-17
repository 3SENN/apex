/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import {
  RESUME_SETTLE_MS,
  SOLVED_CONFIRM_MS,
  activityKey,
  isChallengePage,
  kindFromLabel,
  reduceControl,
  type AgentControlView,
  type ControlAction,
  type ControlMap,
  type NoticePosition,
} from '@shared/agentControl'
import type { AgentEvent } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import type { ChatServices } from '@shared/services/chat'
import type { ControlSignal } from './agent/host'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { onAgentPointer } from './input'
import { log } from './log'
import type { Tab } from './tabs'

// The agent at work (OV-21, OV-22, DS-26). Keeps each
// controlled tab's state (driving, paused, taken over, challenge, resuming)
// from the host's claims and chat events, runs the notice's actions, spots
// human-verification pages and reports the agent's pointer. Every change goes
// out as `agent-control` (the small form the window core reads) and
// `agent-control-view` (what the chrome needs for the notice and shield).

export interface AgentControlHost {
  onControl(listener: (signal: ControlSignal) => void): () => void
  companionOf(chatId: string): string | null
  stop(chatId: string): string[]
  pause(chatId: string): void
  resume(chatId: string): void
  noteForNextResult(tabId: string, text: string): void
}

export interface AgentControlDeps {
  agent: AgentControlHost
  /** A tab by its global id, wherever it lives. */
  tab(tabId: string): Tab | undefined
  tabByWebContents(webContentsId: number): Tab | undefined
  windowOf(tabId: string): WindowContext | undefined
  broadcast(event: AppEvent): void
  now?(): number
}

/** The agent's pointer is sent at most this often per tab. */
const CURSOR_MS = 40

export class AgentControl {
  readonly #deps: AgentControlDeps
  #map: ControlMap = new Map()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly #cursorAt = new Map<string, number>()
  readonly #unsubscribe: (() => void)[] = []

  constructor(deps: AgentControlDeps) {
    this.#deps = deps
  }

  start(): void {
    this.#unsubscribe.push(this.#deps.agent.onControl((signal) => this.#onSignal(signal)))
    this.#unsubscribe.push(onAgentPointer((wc, point) => this.#onPointer(wc, point)))
  }

  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off()
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  states(): AgentControlView[] {
    return [...this.#map.values()]
  }

  view(tabId: string): AgentControlView | undefined {
    return this.#map.get(tabId)
  }

  /** Whether the agent holds this tab (any state but idle): the selection chip never shows there. */
  controls(tabId: string): boolean {
    return this.#map.has(tabId)
  }

  // ---- the notice's actions ----

  takeOver(tabId: string): void {
    const view = this.#map.get(tabId)
    if (!view || view.state === 'taken-over') return
    this.#call(() => this.#deps.agent.pause(view.chatId), 'pause')
    this.#dispatch({ type: 'take-over', tabId })
    // Hand the person the tab: bring it forward and give it the keyboard.
    const win = this.#deps.windowOf(tabId)
    const tab = this.#deps.tab(tabId)
    if (win && tab && win.tabs.activeId() !== tabId) win.tabs.activate(tabId)
    if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
  }

  handBack(tabId: string): void {
    const view = this.#map.get(tabId)
    if (!view || (view.state !== 'taken-over' && view.state !== 'paused')) return
    if (view.state === 'taken-over') this.#call(() => this.#deps.agent.noteForNextResult(tabId, mainT('atWork.takenOverNote')), 'note')
    this.#dispatch({ type: 'hand-back', tabId })
    this.#call(() => this.#deps.agent.resume(view.chatId), 'resume')
    this.#settleLater(tabId, RESUME_SETTLE_MS)
  }

  pause(chatId: string): void {
    this.#call(() => this.#deps.agent.pause(chatId), 'pause')
    this.#dispatch({ type: 'pause', chatId })
  }

  resume(chatId: string): void {
    this.#dispatch({ type: 'resume', chatId })
    this.#call(() => this.#deps.agent.resume(chatId), 'resume')
    for (const view of this.#map.values()) if (view.chatId === chatId && view.state === 'resuming') this.#settleLater(view.tabId, RESUME_SETTLE_MS)
  }

  challengeDone(tabId: string): void {
    const view = this.#map.get(tabId)
    if (!view || view.state !== 'challenge') return
    this.#dispatch({ type: 'challenge-done', tabId, at: this.#now() })
    this.#call(() => this.#deps.agent.resume(view.chatId), 'resume')
    this.#settleLater(tabId, SOLVED_CONFIRM_MS)
  }

  /** Leaves a page that wants a person: back one step, and the agent hears why. */
  skipPage(tabId: string): void {
    const view = this.#map.get(tabId)
    if (!view) return
    this.#call(() => this.#deps.agent.noteForNextResult(tabId, mainT('atWork.skipNote')), 'note')
    const wc = this.#deps.tab(tabId)?.view.webContents
    if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    if (view.state === 'challenge') {
      this.#dispatch({ type: 'challenge-done', tabId, at: 0 })
      this.#call(() => this.#deps.agent.resume(view.chatId), 'resume')
      this.#settleLater(tabId, RESUME_SETTLE_MS)
    }
  }

  moveNotice(tabId: string, position: NoticePosition | null): void {
    this.#dispatch({ type: 'move', tabId, position })
  }

  nudge(tabId: string): void {
    this.#dispatch({ type: 'nudge', tabId })
  }

  stopTab(tabId: string): void {
    const view = this.#map.get(tabId)
    if (view) this.#deps.agent.stop(view.chatId)
  }

  reveal(tabId: string, where: 'page' | 'beside'): void {
    const view = this.#map.get(tabId)
    const win = this.#deps.windowOf(tabId)
    if (!view || !win) return
    win.send({ type: 'chat-open', chatId: view.chatId, where, ...(where === 'beside' ? { toggle: true } : {}) })
  }

  /** The `agent` service namespace. */
  services(): ChatServices['agent'] {
    return {
      takeOver: (tabId) => this.takeOver(tabId),
      handBack: (tabId) => this.handBack(tabId),
      pause: (chatId) => this.pause(chatId),
      resume: (chatId) => this.resume(chatId),
      challengeDone: (tabId) => this.challengeDone(tabId),
      skipPage: (tabId) => this.skipPage(tabId),
      controlStates: () => this.states(),
      moveNotice: (tabId, position) => this.moveNotice(tabId, position),
      nudge: (tabId) => this.nudge(tabId),
      stopTab: (tabId) => this.stopTab(tabId),
      reveal: (tabId, where) => this.reveal(tabId, where),
    }
  }

  // ---- human verification ----

  /** Looks at a controlled tab's page and frames after it loads or retitles. */
  checkChallenge(tab: Tab): void {
    const view = this.#map.get(tab.id)
    const wc = tab.view.webContents
    if (!view || wc.isDestroyed()) return
    let frames: string[] = []
    try {
      frames = wc.mainFrame.framesInSubtree.filter((f) => f !== wc.mainFrame && !f.detached).map((f) => f.url)
    } catch {
      // A frame tree that is being torn down; the next load checks again.
    }
    const challenged = isChallengePage({ url: wc.getURL(), title: wc.getTitle(), frames })
    if (challenged && (view.state === 'driving' || view.state === 'resuming')) {
      this.#clearTimer(tab.id)
      this.#dispatch({ type: 'challenge', tabId: tab.id })
      this.#call(() => this.#deps.agent.pause(view.chatId), 'pause')
    } else if (!challenged && view.state === 'challenge') {
      // The page moved on by itself (the check passed): confirm and carry on.
      this.challengeDone(tab.id)
    }
  }

  /** Per-tab watchers (Feature.tab): page loads and title changes may be a check appearing or going away. */
  watchTab(tab: Tab): () => void {
    const wc = tab.view.webContents
    const check = (): void => this.checkChallenge(tab)
    const events = ['did-finish-load', 'did-frame-finish-load', 'page-title-updated', 'did-navigate-in-page'] as const
    for (const e of events) wc.on(e as 'did-finish-load', check)
    return () => {
      this.#clearTimer(tab.id)
      this.#cursorAt.delete(tab.id)
      if (wc.isDestroyed()) return
      for (const e of events) wc.off(e as 'did-finish-load', check)
    }
  }

  // ---- internals ----

  #onSignal(signal: ControlSignal): void {
    switch (signal.kind) {
      case 'claim': {
        const companionId = this.#deps.agent.companionOf(signal.chatId) ?? ''
        this.#dispatch({ type: 'claim', tabId: signal.tabId, chatId: signal.chatId, companionId })
        const tab = this.#deps.tab(signal.tabId)
        if (tab) this.checkChallenge(tab)
        return
      }
      case 'release':
        this.#clearTimer(signal.tabId)
        this.#dispatch({ type: 'release', tabId: signal.tabId })
        return
      case 'event':
        this.#onEvent(signal.chatId, signal.event)
    }
  }

  #onEvent(chatId: string, event: AgentEvent): void {
    if (event.type === 'tool' && event.state === 'running') {
      const kind = event.kind ?? kindFromLabel(event.label)
      const words = mainT(activityKey(kind), { name: event.connector?.name ?? '' })
      this.#dispatch({ type: 'activity', chatId, activity: words, started: true })
    } else if (event.type === 'status') {
      if (event.status === 'awaiting-approval') this.#dispatch({ type: 'activity', chatId, activity: mainT('atWork.activity.approval'), started: false })
      else if (event.status === 'running') this.#dispatch({ type: 'activity', chatId, activity: null, started: false })
    }
  }

  #onPointer(wc: WebContents, point: { x: number; y: number }): void {
    const tab = this.#deps.tabByWebContents(wc.id)
    if (!tab || !this.#map.has(tab.id)) return
    const now = this.#now()
    if (now - (this.#cursorAt.get(tab.id) ?? 0) < CURSOR_MS) return
    this.#cursorAt.set(tab.id, now)
    const win = this.#deps.windowOf(tab.id)
    win?.send({ type: 'agent-cursor', tabId: tab.id, x: point.x, y: point.y })
  }

  #dispatch(action: ControlAction): void {
    const before = this.#map
    this.#map = reduceControl(before, action)
    if (this.#map === before) return
    const tabs = new Set([...before.keys(), ...this.#map.keys()])
    for (const tabId of tabs) {
      const was = before.get(tabId)
      const now = this.#map.get(tabId)
      if (was === now) continue
      this.#emit(tabId, now ?? null, was ?? null)
    }
  }

  #emit(tabId: string, view: AgentControlView | null, was: AgentControlView | null): void {
    const base = view ?? was
    if (!base) return
    const small: AppEvent = { type: 'agent-control', tabId, chatId: base.chatId, companionId: base.companionId, state: view?.state ?? 'idle', activity: view?.activity ?? null }
    this.#deps.broadcast(small)
    this.#deps.broadcast({ type: 'agent-control-view', tabId, view })
  }

  #settleLater(tabId: string, ms: number): void {
    this.#clearTimer(tabId)
    this.#timers.set(
      tabId,
      setTimeout(() => {
        this.#timers.delete(tabId)
        this.#dispatch({ type: 'settle', tabId })
      }, ms),
    )
  }

  #clearTimer(tabId: string): void {
    const timer = this.#timers.get(tabId)
    if (timer) clearTimeout(timer)
    this.#timers.delete(tabId)
  }

  /** Calls the host's pause, resume or notes; when one isn't available the notice still works, the agent just doesn't wait. */
  #call(run: () => void, what: string): void {
    try {
      run()
    } catch (err) {
      log.debug('agent-control', `${what} is not available yet`, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}
