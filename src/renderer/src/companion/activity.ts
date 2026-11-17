/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { ACTIVITY_PROP_PART, type CompanionEngine, type CompanionLook } from '@shared/companion'
import { NO_PROP, heldPropAfter, heldPropShown, type ActivityProp, type HeldProp } from '@shared/agentControl'
import { engineReady, isEngine, type EngineStatus } from '@shared/engine'
import { atelier, call } from '../api'

// The companion acts out the agent's steps. One store for the chrome
// follows every chat's events and says which prop a chat's companion holds
// (a book while reading, a magnifier while searching, a typing pad while it
// fills in forms), and whether the engine can run at all (the figure looks
// desaturated when it can't).

const held = new Map<string, HeldProp>()
/** chat id → companion id, from the live chat list, so a figure without a chat follows its companion's newest step. */
const owners = new Map<string, string>()
let latest: { chatId: string; at: number } | null = null
let engine: EngineStatus | null = null
let started = false
let timer: ReturnType<typeof setTimeout> | null = null
let version = 0
const listeners = new Set<() => void>()

function notify(): void {
  version++
  for (const listener of listeners) listener()
  schedule()
}

/** Wakes once the next held prop runs out, so it is put away on time. */
function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  const now = Date.now()
  let next = Infinity
  for (const h of held.values()) if (h.prop && h.until > now && h.until < next) next = h.until
  if (next !== Infinity) timer = setTimeout(notify, next - now + 16)
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  atelier.agent.onEvent((event, meta) => {
    const now = Date.now()
    const before = held.get(meta.chatId) ?? NO_PROP
    const after = heldPropAfter(before, event, now)
    if (after === before) return
    if (after.prop) {
      held.set(meta.chatId, after)
      latest = { chatId: meta.chatId, at: now }
    } else held.delete(meta.chatId)
    if (heldPropShown(before, now) !== heldPropShown(after, now)) notify()
    else schedule()
  })
  atelier.onAppEvent((event) => {
    if (event.type === 'chats') {
      for (const c of event.items) owners.set(c.id, c.companionId)
    } else if (event.type === 'engine') {
      engine = event.status
      notify()
    }
  })
  call('chats', 'list', { limit: 1000 }).then((items) => items.forEach((c) => owners.set(c.id, c.companionId)), () => undefined)
  call('engine', 'status').then(
    (status) => {
      engine ??= status
      notify()
    },
    () => undefined,
  )
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function propFor(chatId: string | null | undefined, companionId: string | undefined): ActivityProp | null {
  const now = Date.now()
  if (chatId) return heldPropShown(held.get(chatId) ?? NO_PROP, now)
  // No chat named: the companion's newest working chat leads.
  if (!companionId || !latest || owners.get(latest.chatId) !== companionId) return null
  return heldPropShown(held.get(latest.chatId) ?? NO_PROP, now)
}

/** The prop this figure holds right now, if any. */
export function useHeldProp(chatId: string | null | undefined, companionId: string | undefined): ActivityProp | null {
  return useSyncExternalStore(subscribe, () => propFor(chatId, companionId))
}

/** False once the engine status says this companion's engine can't run (no key, another engine signed out). */
export function useEngineAvailable(own: CompanionEngine | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => {
    void version
    if (!engine) return true
    return engineReady(engine, isEngine(own) ? own : engine.engine)
  })
}

/** The look with the step's prop in the mitten; the look itself when there is none. */
export function lookWithProp(look: CompanionLook, prop: ActivityProp | null): CompanionLook {
  if (!prop) return look
  const part = ACTIVITY_PROP_PART[prop]
  return look.parts.prop === part ? look : { ...look, parts: { ...look.parts, prop: part } }
}
