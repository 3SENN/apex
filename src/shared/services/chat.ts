/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat services and events: chat previews, interrupting and
// queue control, drafts, tabs used, and the agent's control state.
import type { AgentEvent } from '../ipc'
import type { AgentControlView, NoticePosition } from '../agentControl'

export interface ChatPreview {
  kind: 'chat' | 'routine-run' | 'agent-task'
  lastRequest: { text: string; source: 'you' | 'routine' | 'voice' | 'selection' } | null
  replySnippet: string | null
  progress: 'idle' | 'working' | 'needs-you' | 'done' | 'error'
  pending: { kind: 'approval' | 'question' | 'handoff'; label: string }[]
  pendingCount: number
  nextRunAt: number | null
}

export interface TabUsed {
  tabId: string
  title: string
  url: string
}

export interface QuoteInput {
  text: string
  url: string
  links: string[]
}

export interface ChatsServiceAdditions {
  preview(id: string): ChatPreview
  /** Continues after the step limit (CH-15). */
  continue(id: string): void
  /** ⌘↩ while working: stops at the next safe point and sends `text`. */
  interrupt(id: string, text: string): void
  sendNow(id: string, queuedId: string): void
  retryQueued(id: string, queuedId: string): void
  setActWithoutAsking(id: string, on: boolean): void
  setMuted(id: string, muted: boolean): void
  tabsUsed(id: string): TabUsed[]
  closeTabsUsed(id: string, tabIds?: string[]): void
  /** Older log events for a long chat, page by page. */
  older(id: string, beforeSeq: number, limit: number): { events: AgentEvent[]; hasOlder: boolean }
  draft(id: string): string
  setDraft(id: string, text: string): void
  /** Opens the panel on a new chat about a page (the link menu's Ask). */
  askAbout(url: string): void
  /** ⌘J with a selection: the panel opens with it quoted. */
  quote(input: QuoteInput): void
  /** SS-05: writes the chat to disk again after a failed save. */
  retrySave(id: string): void
}

export type AgentControlState = 'driving' | 'paused' | 'taken-over' | 'challenge' | 'resuming' | 'idle'

export interface ChatServices {
  agent: {
    takeOver(tabId: string): void
    handBack(tabId: string): void
    pause(chatId: string): void
    resume(chatId: string): void
    /** A person finished a captcha or sign-in challenge; the agent goes on. */
    challengeDone(tabId: string): void
    skipPage(tabId: string): void
    // OV-21, OV-22: what the overlay surfaces call
    /** Every tab the agent holds, for a chrome or overlay that mounts after the events went out. */
    controlStates(): AgentControlView[]
    /** The notice was dragged; null puts it back in its default spot. */
    moveNotice(tabId: string, position: NoticePosition | null): void
    /** The shield caught a click: the notice offers take over. */
    nudge(tabId: string): void
    /** Stops the chat working in this tab (the notice's Stop). */
    stopTab(tabId: string): void
    /** Opens the tab's chat as a page, or beside the page in the panel (toggles). */
    reveal(tabId: string, where: 'page' | 'beside'): void
  }
}

export type ChatEvent =
  | {
      type: 'agent-control'
      tabId: string
      chatId: string
      companionId: string
      state: AgentControlState
      activity: string | null
    }
  /** The full control view of one tab (position, solved, nudge); `agent-control` stays the small form other features read. */
  | { type: 'agent-control-view'; view: AgentControlView | null; tabId: string }
  /** Where the agent's pointer is on a tab, in the tab's CSS px (the shield draws it). */
  | { type: 'agent-cursor'; tabId: string; x: number; y: number }
  /**
   * Main asks the window's chrome to show a chat: as a page, or beside the
   * page in the panel (chatId null keeps the panel's chat). A quote lands in
   * the panel's composer (OV-20's Ask, ⌘J with a selection, the page menu).
   */
  | { type: 'chat-open'; chatId: string | null; where: 'page' | 'beside'; toggle?: boolean; quote?: QuoteInput }
  /** SS-05: a chat could not be written to disk (the error), or a later write worked again (null). */
  | { type: 'chat-save-state'; chatId: string; error: string | null }
