/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for chats: summaries, filters, the per-chat view a surface loads
// before it follows live events, and the envelope those events travel in.
// Main runs one agent session per chat (src/main/agent/host.ts).
import type { EngineId } from './engine'
import type { AgentEvent, AgentStatus, Effort } from './ipc'
import type { DelegationStatus } from './agentTools'
import type { RefAttachment } from './attachments'

/** Owner value for items every companion can use. Companion ids never take this value. */
export const SHARED_OWNER = 'shared'

/**
 * Lifecycle shown on badges. `finished` and `error` describe the last run;
 * `idle` is a chat that has not run yet or was stopped by you.
 */
export type ChatStatus = 'idle' | 'running' | 'needs-approval' | 'error' | 'finished'

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  /** Last time the saved history changed. */
  updatedAt: number
  /** Last time you sent a message or a run ended. Drives recent sorting and "used … ago". */
  lastActiveAt: number
  /** Set when the chat is a routine run. */
  routineId: string | null
  /** The companion that owns the chat. It may name a deleted companion: show a neutral avatar. */
  companionId: string
  /** The model fixed for this chat ('' for old chats whose model is unknown). */
  model: string
  status: ChatStatus
  /** A run finished while no surface was showing the chat. */
  unread: boolean
  pinned: boolean
  archived: boolean
  /** The agent stopped and waits for you: it asked a question, hit the step cap or was cut off. */
  needsInput: boolean
  /** True until the first message. Drafts live in memory only and are never listed. */
  draft: boolean
  // Ledger row defaults in CHAT_SUMMARY_FLAG_DEFAULTS
  /** The agent acts without asking for approval in this chat (CH-17). */
  actWithoutAsking: boolean
  /** No notifications for this chat (NS-01). */
  muted: boolean
  // Ledger rows defaults in CHAT_SUMMARY_LINK_DEFAULTS
  /** CH-30: never written to the chat store, the search index or usage chat rows. */
  private: boolean
  /** A delegated child chat's parent (hidden from lists). */
  parentChatId: string | null
  delegationStatus: DelegationStatus | null
  projectId: string | null
  /** An imported, read-only transcript (CH-31). */
  imported: { source: 'chatgpt' | 'claude' | 'atelier'; originalTitle: string; originalCreatedAt: number | null; importedAt: number } | null
  /** The routine run this chat is (SK-12's header). */
  routineRun: { runId: string; scheduledFor: number; trigger: 'schedule' | 'manual' | 'catch-up' } | null
}

/** Defaults for the act-without-asking and muted fields on older chats (normalizeSummary fills them). */
export const CHAT_SUMMARY_FLAG_DEFAULTS: Readonly<Pick<ChatSummary, 'actWithoutAsking' | 'muted'>> = {
  actWithoutAsking: false,
  muted: false,
}

/** Defaults for the private, delegation, project, import and routine fields on older chats (normalizeSummary fills them). */
export const CHAT_SUMMARY_LINK_DEFAULTS: Readonly<Pick<ChatSummary, 'private' | 'parentChatId' | 'delegationStatus' | 'projectId' | 'imported' | 'routineRun'>> = {
  private: false,
  parentChatId: null,
  delegationStatus: null,
  projectId: null,
  imported: null,
  routineRun: null,
}

export type ChatSort = 'recent' | 'oldest' | 'best-match'

export interface ChatListFilter {
  /** Matches titles and message text; every word must match. */
  query?: string
  companionId?: string
  /** 'only' lists routine runs, 'exclude' hides them. */
  routine?: 'only' | 'exclude'
  /** 'archived' lists archived chats only; otherwise archived chats are left out. */
  status?: 'unread' | 'needs-input' | 'archived'
  /** Default 'recent'. 'best-match' needs a query and falls back to recent without one. Pinned chats always come first. */
  sort?: ChatSort
  offset?: number
  /** Default 200. */
  limit?: number
  // Private chats are never listed
  projectId?: string
  /** Delegated children; default 'exclude'. */
  children?: 'exclude' | 'only' | 'include'
  imported?: 'only' | 'exclude'
}

/** Choices a new chat can make before its first message. Omitted fields follow the companion, then the global settings. */
export interface NewChatOptions {
  companionId?: string
  model?: string
  effort?: Effort
  /** ST-58: the engine this chat runs on. */
  engine?: EngineId
  private?: boolean
  projectId?: string
}

/** What a chat runs with. Fixed at the first message; before that it shows what would be used. */
export interface ChatSetup {
  companionId: string
  model: string
  effort: Effort
  /** False for routine runs, which never control tabs. */
  browser: boolean
  webTools: boolean
  memory: boolean
  connectorIds: string[]
  /** What runs the chat's model turns (ST-58). Fixed with the rest of the setup. */
  engine: EngineId
  /** True once the first message fixed the setup; changing it then means a new chat. */
  fixed: boolean
  // Frozen with the rest at the first message
  /** Client-tool names, sorted, from the registry. */
  clientTools: string[]
  private: boolean
  // Fixed at the first message; false for older chats
  /** Code execution with the document skills (Settings › Files and documents). */
  documents: boolean
  /** Server-side compaction; compaction blocks stay in the history. */
  compaction: boolean
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Details for one model turn, keyed by the `turnId` of its text and thinking events. */
export interface MessageDetails {
  turnId: string
  /** When the turn finished. */
  at: number
  /** The model that answered; differs from the chat's model after a server-side fallback. */
  model: string
  usage: TurnUsage
  stopReason: string | null
  /** Memory files this turn created, edited, renamed or deleted, as the agent named them (see memoryLocation). */
  memoryPaths: string[]
  /** What answered: absent for the API key (older chats too), else the engine's id. */
  engine?: EngineId
  /** What another engine reported the reply cost on your own account, in US dollars; on the reply's last turn. */
  costUsd?: number
  /** DC-15: the effort the turn ran at, when a quick decision moved it from the chat's. */
  effort?: Effort
}

export type FeedbackRating = 'helpful' | 'not-helpful'

/** Stored on the chat only; never sent to the model. */
export interface ChatFeedback {
  rating: FeedbackRating
  note: string
  at: number
}

/** Where a message came from, when not typed in the composer (the ChatPreview source). */
export type MessageSource = 'routine' | 'voice' | 'selection'

/** A message sent while the chat was running; it goes out when the run ends. */
export interface QueuedMessage {
  id: string
  text: string
  // CH-15, SS-06
  /** Absent for messages you typed. */
  source?: MessageSource
  /** Why sending it failed; the queue holds here until you retry it (chats.retryQueued) or remove it. */
  failed?: string
  /** It waits for the connection to come back (SS-06). */
  offline?: boolean
}

/** Everything a surface needs to show a chat before it follows live events. */
export interface ChatView {
  summary: ChatSummary
  setup: ChatSetup
  /** The compacted event log. Fold it with the same reducer as live events. */
  log: AgentEvent[]
  /** Live events with `seq` at or below this are already in `log`. */
  seq: number
  agentStatus: AgentStatus
  details: Record<string, MessageDetails>
  feedback: Record<string, ChatFeedback>
  queued: QueuedMessage[]
  /** Tabs this chat controls right now. */
  tabIds: string[]
  /** Open tabs the chat acted on since Atelier started, controlled or not (the header's tabs list). */
  usedTabIds: string[]
  // CH-13, SS-05, CH-14 to CH-18
  /** Index of `log[0]` in the whole saved log: long chats load their newest page first (chats.older pages back). */
  logStart?: number
  /** The last write to disk failed (SS-05): the chat shows it with Retry (chats.retrySave). */
  saveError?: string | null
  /** The run waits at a safe point (agent.pause, the shield's take-over). */
  paused?: boolean
  /** The file could not be migrated, or a newer Atelier saved it. The chat opens read-only with the composer disabled. */
  notice?: { kind: 'migration-failed' | 'newer-format'; message: string; /** An original in chats/.backup can be restored. */ backup?: boolean } | null
}

/** Which chat an agent event belongs to. `seq` rises across all chats. */
export interface ChatEventMeta {
  chatId: string
  seq: number
}

/** An agent event as main sends it on UI.agentEvent; the preload hands listeners (event, meta). */
export interface ChatAgentEvent extends ChatEventMeta {
  event: AgentEvent
}

/**
 * Where a memory path from a chat lives. The agent sees its companion's own
 * folder at /memories/ and the shared folder at /memories/shared/.
 */
export function memoryLocation(agentPath: string, companionId: string): { owner: string; path: string } {
  if (agentPath === '/memories/shared' || agentPath.startsWith('/memories/shared/')) {
    return { owner: SHARED_OWNER, path: `/memories${agentPath.slice('/memories/shared'.length)}` }
  }
  return { owner: companionId, path: agentPath }
}

export type ChatDateGroup = 'today' | 'yesterday' | 'week' | 'month' | 'older'

/** The All chats date group for a timestamp, in local time: previous 7 days, previous 30 days, then older. */
export function chatDateGroup(at: number, now = Date.now()): ChatDateGroup {
  const day = new Date(now)
  // Calendar days, so DST changes don't shift a boundary by an hour.
  const startOf = (daysAgo: number): number => new Date(day.getFullYear(), day.getMonth(), day.getDate() - daysAgo).getTime()
  if (at >= startOf(0)) return 'today'
  if (at >= startOf(1)) return 'yesterday'
  if (at >= startOf(7)) return 'week'
  if (at >= startOf(30)) return 'month'
  return 'older'
}

// Attachment references and more chat methods
/**
 * A message's attachments as the chrome sends them: the image and meeting
 * kinds widened with a reference to an AttachmentStore entry, at most
 * ATTACHMENT_LIMITS.perMessage (20). Main resolves `ref`
 * through AttachmentStore.resolve and an inline image through the store's
 * `inline` source first.
 */
export type MessageAttachmentInput = MessageAttachment | RefAttachment

/** Compaction and continuing in a new chat, added to Services.chats. */
export interface ChatsCompactionMethods {
  /** SS-03 and CH-26: compacts the history now (manual compaction). */
  compact(id: string): void
  /** CH-41: a new chat with the original message and its attachments, plus these connectors. */
  continueInNewChat(id: string, options?: { connectorIds?: string[] }): ChatSummary
}

/** CH-47: duplicate copied what it could; `failedAttachments` counts what it couldn't. */
export type ChatDuplicatedEvent = { type: 'chat-duplicated'; chatId: string; sourceId: string; failedAttachments: number }

// MessageAttachmentInput adds { kind: 'ref' }, raises the limit to 20 and logs AttachmentRef
/** The inline attachments the chrome sends with a message: a screenshot or a meeting, at most MESSAGE_ATTACHMENTS_MAX. */
export type MessageAttachment =
  | { kind: 'image'; mediaType: 'image/jpeg' | 'image/png'; /** base64, at most IMAGE_ATTACHMENT_BASE64_MAX */ data: string; label?: string; masked?: boolean }
  | { kind: 'meeting'; meetingId: string }

/** How a sent attachment shows in the log (the 'user-message' event). */
export type AttachmentView =
  | { kind: 'image'; /** small jpeg data URL */ thumbnail: string; label?: string }
  | { kind: 'meeting'; meetingId: string; title: string }

export const MESSAGE_ATTACHMENTS_MAX = 4

/** The most model steps one run takes before it stops for Continue, on every engine, unless Settings › No step limit is on (CH-14). */
export const MAX_STEPS = 60
/** 5 MB of base64 text. */
export const IMAGE_ATTACHMENT_BASE64_MAX = 5 * 1024 * 1024
