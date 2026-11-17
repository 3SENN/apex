/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { ChatSummary } from '@shared/chats'
import type { CompanionMood } from '@shared/companion'
import { apex, call } from '../api'
import {
  chatIsLive,
  chatMood,
  chatTyping,
  companionMood,
  idleStage,
  initialPresence,
  moodMark,
  nextChange,
  reducePresence,
  summaryMood,
  type AvatarMark,
  type IdleStage,
  type PresenceAction,
  type PresenceSignal,
  type PresenceState,
} from './presenceCore'

// One presence store for the whole chrome (DS-68). Every live companion and
// small face of a companion or chat reads it, so they never disagree. The
// reducer and the mood rules live in presenceCore.ts.

export type { AvatarMark, IdleStage, PresenceSignal } from './presenceCore'
export { moodMark, summaryMood } from './presenceCore'

let state: PresenceState = initialPresence(Date.now())
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
/** Companions on record, so a new one gets a celebration and the first list does not. */
let knownCompanions: Set<string> | null = null
const INPUT_THROTTLE_MS = 1000
let lastInputDispatch = 0

function notify(): void {
  for (const listener of listeners) listener()
  schedule()
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const left = nextChange(state, Date.now())
  // A frame late, so the derived mood has really changed when views read it.
  if (left !== null) timer = setTimeout(notify, left + 16)
}

function dispatch(action: PresenceAction): void {
  const before = state
  const wasStage = action.type === 'input' ? idleStage(before, action.at) : null
  state = reducePresence(state, action)
  if (state === before) return
  // Pointer moves only matter when they wake a drowsy companion.
  if (wasStage === 'awake') {
    schedule()
    return
  }
  notify()
}

function seedCompanions(ids: readonly string[]): void {
  if (!knownCompanions) {
    knownCompanions = new Set(ids)
    return
  }
  const at = Date.now()
  for (const id of ids) {
    if (knownCompanions.has(id)) continue
    knownCompanions.add(id)
    dispatch({ type: 'cheer', companionId: id, at })
  }
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  apex.agent.onEvent((event, meta) => dispatch({ type: 'agent', chatId: meta.chatId, event, at: Date.now() }))
  apex.onAppEvent((event) => {
    if (event.type === 'chats') dispatch({ type: 'chats', items: event.items, at: Date.now() })
    else if (event.type === 'companions') seedCompanions(event.items.map((c) => c.id))
    // DS-68: quick ask's composer (its own window) is an input like any other.
    else if (event.type === 'quick-ask-presence') dispatch({ type: 'signal', signal: event.signal, companionId: event.companionId, chatId: null, at: Date.now() })
  })
  call('chats', 'list', { limit: 1000 }).then((items) => dispatch({ type: 'chats', items, at: Date.now() }), () => undefined)
  call('companions', 'list').then((items) => seedCompanions(items.map((c) => c.id)), () => undefined)
  const onInput = (): void => {
    const at = Date.now()
    const drowsy = idleStage(state, at) !== 'awake'
    if (!drowsy && at - lastInputDispatch < INPUT_THROTTLE_MS) return
    lastInputDispatch = at
    dispatch({ type: 'input', at })
  }
  window.addEventListener('pointermove', onInput, { passive: true })
  window.addEventListener('pointerdown', onInput, { passive: true })
  window.addEventListener('keydown', onInput)
  window.addEventListener('wheel', onInput, { passive: true })
  schedule()
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Subscribes to one derived value, as a string, so a component re-renders
 * only when its own value changes (streamed chunks would otherwise wake
 * every face on screen).
 */
function useDerived(derive: () => string): string {
  return useSyncExternalStore(subscribe, derive)
}

// ---- the cross-surface contract ----

/**
 * Called by every composer: 'typing' on each keystroke (and on focus with
 * text), 'sent' on send, 'idle' when typing stops or the field loses focus.
 * `chatId` names the chat when the composer belongs to one.
 */
export function signalPresence(signal: PresenceSignal, companionId?: string | null, chatId?: string | null): void {
  start()
  const at = Date.now()
  // Keystrokes repeat the same signal; one a frame is plenty.
  if (signal === 'typing' && state.last.signal === 'typing' && state.last.companionId === (companionId ?? null) && at - state.last.at < 120) return
  dispatch({ type: 'signal', signal, companionId: companionId ?? null, chatId: chatId ?? null, at })
}

/** The latest composer signal. */
export function usePresenceSignal(): { signal: PresenceSignal; companionId: string | null; at: number } {
  return useSyncExternalStore(subscribe, () => state.last)
}

// ---- reading presence ----

export interface CompanionPresenceView {
  mood: CompanionMood
  /** Increments with each streamed chunk of this companion's replies. */
  talkPulse: number
  idle: IdleStage
  /** Increments when the companion should celebrate (it was just added). */
  cheer: number
  /** When it last did (0: never), so a figure mounting just after still plays it (DS-79). */
  cheerAt: number
}

/** A companion's mood across its chats and composers, kept live. */
export function useCompanionPresence(companionId: string | null | undefined): CompanionPresenceView {
  const key = useDerived(() => {
    const now = Date.now()
    const idle = idleStage(state, now)
    if (!companionId) return `${idle === 'napping' ? 'sleeping' : 'idle'}|0|${idle}|0|0`
    const own = state.companions[companionId]
    return `${companionMood(state, companionId, now).mood}|${own?.talk ?? 0}|${idle}|${own?.cheer ?? 0}|${own?.cheerAt ?? 0}`
  })
  const [mood, talk, idle, cheer, cheerAt] = key.split('|')
  return { mood: mood as CompanionMood, talkPulse: Number(talk), idle: idle as IdleStage, cheer: Number(cheer), cheerAt: Number(cheerAt) }
}

function chatKey(chatId: string | null | undefined, fallback: CompanionMood, withTalk: boolean): string {
  if (!chatId) return `${fallback}|0|0`
  const now = Date.now()
  const live = chatIsLive(state, chatId, now)
  const talk = withTalk ? (state.chats[chatId]?.talk ?? 0) : 0
  return `${live ? chatMood(state, chatId, now).mood : fallback}|${talk}|${live ? 1 : 0}`
}

/** One chat's mood, kept live; `fallback` is used while nothing live is known about the chat. */
export function useChatPresence(chatId: string | null | undefined, fallback: CompanionMood = 'idle'): { mood: CompanionMood; talkPulse: number; live: boolean } {
  const [mood, talk, live] = useDerived(() => chatKey(chatId, fallback, true)).split('|')
  return { mood: mood as CompanionMood, talkPulse: Number(talk), live: live === '1' }
}

/** Whether this chat's composer has text; only a live figure in the chat reacts to it (small faces never do). */
export function useChatTyping(chatId: string | null | undefined): boolean {
  return useDerived(() => (chatId && chatTyping(state, chatId, Date.now()) ? '1' : '0')) === '1'
}

/** The face and corner mark of a small avatar that stands for a chat (DS-67). */
export function useChatFace(chat: Pick<ChatSummary, 'id' | 'status' | 'unread' | 'needsInput'> | null | undefined): { mood: CompanionMood; mark: AvatarMark | null } {
  const saved = chat ? summaryMood(chat) : 'idle'
  // Small faces do not talk, so streamed chunks never re-render them.
  const [mood] = useDerived(() => chatKey(chat?.id, saved, false)).split('|') as [CompanionMood]
  return { mood, mark: moodMark(mood, chat?.unread === true) }
}

/** Any interaction with a companion (a poke, a pat) wakes every view of it. */
export function wakePresence(): void {
  start()
  dispatch({ type: 'input', at: Date.now() })
}

/** Plays the celebration on every live view of a companion (also automatic when one is added). */
export function cheerCompanion(companionId: string): void {
  start()
  dispatch({ type: 'cheer', companionId, at: Date.now() })
}
