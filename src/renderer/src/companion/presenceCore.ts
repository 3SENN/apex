/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure presence logic: what every live companion and small face shows, from
// composer signals, agent events and the user's idle time. No DOM and no
// React, so it is unit-tested in node; presence.ts wires it to the chrome.

import type { ChatStatus, ChatSummary } from '@shared/chats'
import type { CompanionMood } from '@shared/companion'
import type { AgentEvent } from '@shared/ipc'

export type PresenceSignal = 'typing' | 'sent' | 'idle'

/**
 * Listening holds while the composer has text (DS-69): composers signal
 * 'typing' when text appears (and on keystrokes) and 'idle' when it is
 * cleared, sent or the field loses focus. This is only a failsafe for a
 * composer that went away without saying so.
 */
export const TYPING_HOLD_MS = 120_000
/** After a send the companion thinks at once; if the agent never reports, it settles after this. */
export const SENT_HOLD_MS = 12_000
/** Talking holds this long after the last streamed chunk. */
export const TALK_HOLD_MS = 700
export const HAPPY_MS = 2600

/**
 * DS-79: a figure that mounts within this long of its companion's cheer (it
 * was just added) still plays the celebration; the new tab re-mounts its
 * figure for the new companion, so it would otherwise miss it.
 */
export const CHEER_FRESH_MS = 4000

/** Whether a cheer at `cheerAt` is recent enough for a figure mounting `now` to play. */
export function cheerIsFresh(cheerAt: number, now: number): boolean {
  return cheerAt > 0 && now - cheerAt >= 0 && now - cheerAt < CHEER_FRESH_MS
}
/** "Briefly sad." */
export const SAD_MS = 1800
/** Without any input the companion starts looking around, then naps. */
export const LOOK_AROUND_MS = 45_000
export const NAP_MS = 3 * 60_000
/** A chat the store has not seen yet belongs to whoever sent last, if that was this recent. */
const ADOPT_MS = 15_000

export type IdleStage = 'awake' | 'looking' | 'napping'

export interface ChatPresence {
  /** Null until the chat list or a send names its owner. */
  companionId: string | null
  run: 'idle' | 'running' | 'approval'
  activity: 'thinking' | 'text' | 'tool'
  activityAt: number
  /** How the last run ended; null for a stop or no run yet. */
  outcome: 'ok' | 'error' | null
  outcomeAt: number
  /** An error event arrived during this run. */
  failed: boolean
  stopped: boolean
  /** Bumped on each streamed text chunk, so views can move the mouth. */
  talk: number
  typingAt: number
  sentAt: number
}

export interface CompanionPresence {
  typingAt: number
  sentAt: number
  talk: number
  /** Bumped by a celebration (the companion was just added); views play it once per bump. */
  cheer: number
  cheerAt: number
}

export interface PresenceState {
  chats: Readonly<Record<string, ChatPresence>>
  companions: Readonly<Record<string, CompanionPresence>>
  /** Last pointer or key input anywhere in the chrome. */
  inputAt: number
  /** The latest composer signal (the cross-surface contract). */
  last: { signal: PresenceSignal; companionId: string | null; at: number }
}

export type PresenceAction =
  | { type: 'signal'; signal: PresenceSignal; companionId: string | null; chatId: string | null; at: number }
  | { type: 'agent'; chatId: string; event: AgentEvent; at: number }
  | { type: 'chats'; items: ReadonlyArray<Pick<ChatSummary, 'id' | 'companionId' | 'status'>>; at: number }
  | { type: 'input'; at: number }
  | { type: 'cheer'; companionId: string; at: number }

export function initialPresence(now: number): PresenceState {
  return { chats: {}, companions: {}, inputAt: now, last: { signal: 'idle', companionId: null, at: 0 } }
}

function emptyChat(companionId: string | null): ChatPresence {
  return { companionId, run: 'idle', activity: 'thinking', activityAt: 0, outcome: null, outcomeAt: 0, failed: false, stopped: false, talk: 0, typingAt: 0, sentAt: 0 }
}

function emptyCompanion(): CompanionPresence {
  return { typingAt: 0, sentAt: 0, talk: 0, cheer: 0, cheerAt: 0 }
}

function withChat(state: PresenceState, id: string, chat: ChatPresence): PresenceState {
  return { ...state, chats: { ...state.chats, [id]: chat } }
}

function withCompanion(state: PresenceState, id: string, update: (c: CompanionPresence) => CompanionPresence): PresenceState {
  const current = state.companions[id] ?? emptyCompanion()
  return { ...state, companions: { ...state.companions, [id]: update(current) } }
}

function seedRun(status: ChatStatus): ChatPresence['run'] {
  if (status === 'running') return 'running'
  if (status === 'needs-approval') return 'approval'
  return 'idle'
}

export function reducePresence(state: PresenceState, action: PresenceAction): PresenceState {
  switch (action.type) {
    case 'input':
      return action.at > state.inputAt ? { ...state, inputAt: action.at } : state
    case 'cheer':
      return withCompanion({ ...state, inputAt: Math.max(state.inputAt, action.at) }, action.companionId, (c) => ({ ...c, cheer: c.cheer + 1, cheerAt: action.at }))
    case 'chats': {
      let chats: Record<string, ChatPresence> | null = null
      for (const item of action.items) {
        const known = state.chats[item.id]
        if (known && known.companionId === item.companionId) continue
        chats ??= { ...state.chats }
        // Live events know better than the list about a chat that is already tracked.
        chats[item.id] = known ? { ...known, companionId: item.companionId } : { ...emptyChat(item.companionId), run: seedRun(item.status), activityAt: item.status === 'running' ? action.at : 0 }
      }
      return chats ? { ...state, chats } : state
    }
    case 'signal':
      return reduceSignal(state, action)
    case 'agent':
      return reduceAgent(state, action)
  }
}

function reduceSignal(state: PresenceState, action: Extract<PresenceAction, { type: 'signal' }>): PresenceState {
  const { signal, companionId, chatId, at } = action
  let next: PresenceState = { ...state, last: { signal, companionId, at }, inputAt: Math.max(state.inputAt, at) }
  const apply = <T extends { typingAt: number; sentAt: number }>(entry: T): T => {
    if (signal === 'typing') return { ...entry, typingAt: at }
    if (signal === 'sent') return { ...entry, typingAt: 0, sentAt: at }
    return { ...entry, typingAt: 0 }
  }
  if (companionId) next = withCompanion(next, companionId, apply)
  if (chatId) next = withChat(next, chatId, apply(next.chats[chatId] ?? emptyChat(companionId)))
  return next
}

function reduceAgent(state: PresenceState, action: Extract<PresenceAction, { type: 'agent' }>): PresenceState {
  const { chatId, event, at } = action
  const known = state.chats[chatId]
  // A chat started a moment ago from a composer belongs to the companion that sent it.
  const adopted = !known && state.last.signal === 'sent' && at - state.last.at < ADOPT_MS ? state.last.companionId : null
  const chat: ChatPresence = { ...(known ?? emptyChat(adopted)) }
  let next = state
  const owner = chat.companionId
  const clearSent = (): void => {
    chat.sentAt = 0
    if (owner && next.companions[owner]?.sentAt) next = withCompanion(next, owner, (c) => ({ ...c, sentAt: 0 }))
  }
  switch (event.type) {
    case 'status':
      if (event.status === 'running') {
        if (chat.run === 'idle') {
          chat.outcome = null
          chat.failed = false
          chat.stopped = false
          chat.activity = 'thinking'
          chat.activityAt = at
        }
        chat.run = 'running'
        clearSent()
      } else if (event.status === 'awaiting-approval') {
        chat.run = 'approval'
        clearSent()
      } else {
        if (chat.run !== 'idle') {
          chat.outcome = chat.failed ? 'error' : chat.stopped ? null : 'ok'
          chat.outcomeAt = at
        }
        chat.run = 'idle'
        clearSent()
      }
      break
    case 'text-delta':
      chat.activity = 'text'
      chat.activityAt = at
      chat.talk += 1
      if (owner) next = withCompanion(next, owner, (c) => ({ ...c, talk: c.talk + 1 }))
      break
    case 'thinking-delta':
      if (chat.activity !== 'text' || at - chat.activityAt >= TALK_HOLD_MS) {
        chat.activity = 'thinking'
        chat.activityAt = at
      }
      break
    case 'tool':
      chat.activity = event.state === 'running' ? 'tool' : 'thinking'
      chat.activityAt = at
      break
    case 'approval':
      chat.run = 'approval'
      break
    case 'approval-resolved':
      if (chat.run === 'approval') chat.run = 'running'
      chat.activity = 'thinking'
      chat.activityAt = at
      break
    case 'error':
      if (event.message === 'Stopped.') chat.stopped = true
      else chat.failed = true
      break
    case 'reset':
      chat.outcome = null
      break
    case 'user-message':
      // A send from a surface that did not signal (another window, a routine).
      if (chat.run === 'idle') chat.sentAt = at
      break
  }
  return withChat(next, chatId, chat)
}

// ---- derived moods ----

export interface DerivedMood {
  mood: CompanionMood
  /** Milliseconds until it would change on its own; null until the next action. */
  changesIn: number | null
}

function held(at: number, hold: number, now: number): number | null {
  if (!(at > 0)) return null
  const left = at + hold - now
  return left > 0 ? left : null
}

function runMood(chat: ChatPresence, now: number): DerivedMood | null {
  if (chat.run === 'approval') return { mood: 'approval', changesIn: null }
  if (chat.run !== 'running') return null
  if (chat.activity === 'tool') return { mood: 'working', changesIn: null }
  const talk = chat.activity === 'text' ? held(chat.activityAt, TALK_HOLD_MS, now) : null
  return talk !== null ? { mood: 'talking', changesIn: talk } : { mood: 'thinking', changesIn: null }
}

function outcomeMood(outcome: ChatPresence['outcome'], at: number, now: number): DerivedMood | null {
  if (outcome === 'ok') {
    const left = held(at, HAPPY_MS, now)
    return left !== null ? { mood: 'happy', changesIn: left } : null
  }
  if (outcome === 'error') {
    const left = held(at, SAD_MS, now)
    return left !== null ? { mood: 'sad', changesIn: left } : null
  }
  return null
}

export function idleStage(state: PresenceState, now: number): IdleStage {
  const quiet = now - state.inputAt
  if (quiet >= NAP_MS) return 'napping'
  if (quiet >= LOOK_AROUND_MS) return 'looking'
  return 'awake'
}

function chatsOf(state: PresenceState, companionId: string): ChatPresence[] {
  return Object.values(state.chats).filter((c) => c.companionId === companionId)
}

/**
 * One companion's mood across all its chats, in priority order: asking,
 * the most recent run (working, talking, thinking), a send the agent has not
 * answered yet, listening, a finished run (happy, briefly sad) or a
 * celebration, a nap, then idle.
 */
export function companionMood(state: PresenceState, companionId: string, now: number): DerivedMood {
  const chats = chatsOf(state, companionId)
  const own = state.companions[companionId]
  if (chats.some((c) => c.run === 'approval')) return { mood: 'approval', changesIn: null }
  const running = chats.filter((c) => c.run === 'running').sort((a, b) => b.activityAt - a.activityAt)[0]
  if (running) return runMood(running, now) as DerivedMood
  const sent = held(Math.max(own?.sentAt ?? 0, ...chats.map((c) => c.sentAt)), SENT_HOLD_MS, now)
  if (sent !== null) return { mood: 'thinking', changesIn: sent }
  const typing = held(own?.typingAt ?? 0, TYPING_HOLD_MS, now)
  if (typing !== null) return { mood: 'listening', changesIn: typing }
  // The latest of a finished run and a celebration shows.
  const last = chats.filter((c) => c.outcome !== null).sort((a, b) => b.outcomeAt - a.outcomeAt)[0]
  const finished = last ? outcomeMood(last.outcome, last.outcomeAt, now) : null
  const cheer = own ? outcomeMood('ok', own.cheerAt, now) : null
  if (finished && cheer) return (last?.outcomeAt ?? 0) >= (own?.cheerAt ?? 0) ? finished : cheer
  const ended = finished ?? cheer
  if (ended) return ended
  if (idleStage(state, now) === 'napping') return { mood: 'sleeping', changesIn: null }
  return { mood: 'idle', changesIn: null }
}

/**
 * One chat's mood from its state alone: small faces (sidebar rows, the chip,
 * the gutter) follow only the chat, never typing (DS-69). A live figure in a
 * chat adds its companion's listening and naps on top (Companion.tsx).
 */
export function chatMood(state: PresenceState, chatId: string, now: number): DerivedMood {
  const chat = state.chats[chatId]
  if (!chat) return { mood: 'idle', changesIn: null }
  const run = runMood(chat, now)
  if (run) return run
  const sent = held(chat.sentAt, SENT_HOLD_MS, now)
  if (sent !== null) return { mood: 'thinking', changesIn: sent }
  return outcomeMood(chat.outcome, chat.outcomeAt, now) ?? { mood: 'idle', changesIn: null }
}

/** Whether you are typing in this chat's own composer: its live figure listens even while the companion works elsewhere (DS-69). */
export function chatTyping(state: PresenceState, chatId: string, now: number): boolean {
  return held(state.chats[chatId]?.typingAt ?? 0, TYPING_HOLD_MS, now) !== null
}

/**
 * The live figure standing in a chat: the chat's own state leads, then its
 * composer's text (listening), then the companion listening to another
 * composer or napping with its other views; otherwise it waits, idle.
 */
export function figureMood(chat: CompanionMood, typingHere: boolean, companion: CompanionMood): CompanionMood {
  if (chat !== 'idle') return chat
  if (typingHere || companion === 'listening') return 'listening'
  return companion === 'sleeping' ? 'sleeping' : 'idle'
}

/** Whether the store knows something live about a chat (otherwise its summary speaks for it). */
export function chatIsLive(state: PresenceState, chatId: string, now: number): boolean {
  const chat = state.chats[chatId]
  if (!chat) return false
  return chat.run !== 'idle' || chatMood(state, chatId, now).changesIn !== null
}

/** Milliseconds until any derived mood or idle stage could change on its own; null if none. */
export function nextChange(state: PresenceState, now: number): number | null {
  let soonest: number | null = null
  const consider = (left: number | null): void => {
    if (left !== null && (soonest === null || left < soonest)) soonest = left
  }
  for (const chat of Object.values(state.chats)) {
    if (chat.run === 'running' && chat.activity === 'text') consider(held(chat.activityAt, TALK_HOLD_MS, now))
    consider(held(chat.sentAt, SENT_HOLD_MS, now))
    consider(held(chat.typingAt, TYPING_HOLD_MS, now))
    if (chat.outcome) consider(held(chat.outcomeAt, chat.outcome === 'ok' ? HAPPY_MS : SAD_MS, now))
  }
  for (const own of Object.values(state.companions)) {
    consider(held(own.sentAt, SENT_HOLD_MS, now))
    consider(held(own.typingAt, TYPING_HOLD_MS, now))
    consider(held(own.cheerAt, HAPPY_MS, now))
  }
  consider(held(state.inputAt, LOOK_AROUND_MS, now))
  consider(held(state.inputAt, NAP_MS, now))
  return soonest
}

// ---- small faces (DS-67) ----

/** The state drawn on a small face's corner. */
export type AvatarMark = 'working' | 'approval' | 'unread' | 'done' | 'error' | 'routine'

/** A chat's mood from its saved summary, for chats with nothing live (after a restart, or in the background). */
export function summaryMood(summary: Pick<ChatSummary, 'status' | 'unread' | 'needsInput'>): CompanionMood {
  switch (summary.status) {
    case 'running':
      return 'working'
    case 'needs-approval':
      return 'approval'
    case 'error':
      return 'sad'
    default:
      if (summary.needsInput) return 'approval'
      return summary.status === 'finished' && summary.unread ? 'happy' : 'idle'
  }
}

/** The corner mark for a mood: busy moods spin, asking shows the amber chip, done pops a check. */
export function moodMark(mood: CompanionMood | undefined, unread = false): AvatarMark | null {
  switch (mood) {
    case 'thinking':
    case 'working':
    case 'talking':
      return 'working'
    case 'approval':
      return 'approval'
    case 'sad':
      return 'error'
    case 'happy':
      return 'done'
    default:
      return unread ? 'unread' : null
  }
}
