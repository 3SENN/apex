/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { SettingsView, TabsSnapshot } from '@shared/ipc'
import type { SpendView } from '@shared/pricing'
import type { AppEvent, ChatSummary, Companion, Routine, Skill } from '@shared/services'
import { apex, call } from '../api'
import { onTabsChanged, tabsSnapshot } from '../companion-card/liveTabs'

// Shared, lazily started stores for what every chat surface reads: settings,
// companions, skills, routines, tabs and the chat list. Each loads once and
// then follows its app event, so many views cost one subscription.

interface Store<T> {
  get(): T
  subscribe(listener: () => void): () => void
}

function liveStore<T>(initial: T, start: (set: (value: T) => void) => void): Store<T> {
  let value = initial
  let started = false
  const listeners = new Set<() => void>()
  const set = (next: T): void => {
    value = next
    for (const listener of listeners) listener()
  }
  return {
    get: () => value,
    subscribe(listener) {
      if (!started) {
        started = true
        start(set)
      }
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function onApp<T extends AppEvent['type']>(type: T, listener: (event: Extract<AppEvent, { type: T }>) => void): void {
  apex.onAppEvent((event) => {
    if (event.type === type) listener(event as Extract<AppEvent, { type: T }>)
  })
}

const settingsStore = liveStore<SettingsView>(apex.initial.settings, (set) => {
  onApp('settings', (e) => set(e.view))
  void apex.settings.get().then(set, () => undefined)
})

export interface CompanionList {
  items: Companion[]
  activeId: string
  loaded: boolean
}

const companionsStore = liveStore<CompanionList>({ items: [], activeId: '', loaded: false }, (set) => {
  onApp('companions', (e) => set({ items: e.items, activeId: e.activeId, loaded: true }))
  void Promise.all([call('companions', 'list'), call('companions', 'activeId')]).then(
    ([items, activeId]) => set({ items, activeId, loaded: true }),
    () => undefined,
  )
})

const skillsStore = liveStore<Skill[]>([], (set) => {
  onApp('skills', (e) => set(e.items))
  void call('skills', 'list').then(set, () => undefined)
})

/** null until the first load. */
const routinesStore = liveStore<Routine[] | null>(null, (set) => {
  onApp('routines', (e) => set(e.items))
  void call('routines', 'list').then(set, () => undefined)
})

// Tabs follow liveTabs, which listens from start-up: the preload's initial
// snapshot is taken before main opens the first tab, so a store that starts
// on first use would read an empty list until the next change.
const tabsStore: Store<TabsSnapshot> = {
  get: tabsSnapshot,
  subscribe: (listener) => onTabsChanged(() => listener()),
}

/** Every saved chat, most recently used first (the 'chats' event carries the full list). */
const chatListStore = liveStore<ChatSummary[] | null>(null, (set) => {
  onApp('chats', (e) => set(e.items))
  void call('chats', 'list', { limit: 200 }).then(set, () => undefined)
})

/** This month's spend on your own key and your budget (DS-18); null until the first load. */
const spendStore = liveStore<SpendView | null>(null, (set) => {
  onApp('spend', (e) => set(e.view))
  void call('spend', 'view').then(set, () => undefined)
})

const use = <T,>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.get)

/** Resolves with the first tabs snapshot that passes `test` (null after `timeoutMs`). */
export function whenTabs<T>(test: (tabs: TabsSnapshot) => T | null, timeoutMs = 3000): Promise<T | null> {
  return new Promise((resolve) => {
    let off = (): void => undefined
    const timer = setTimeout(() => {
      off()
      resolve(null)
    }, timeoutMs)
    const check = (): void => {
      const hit = test(tabsStore.get())
      if (hit === null) return
      clearTimeout(timer)
      off()
      resolve(hit)
    }
    off = tabsStore.subscribe(check)
    check()
  })
}

export const tabsNow = (): TabsSnapshot => tabsStore.get()

export const useSettingsView = (): SettingsView => use(settingsStore)
export const useCompanionList = (): CompanionList => use(companionsStore)
export const useSkills = (): Skill[] => use(skillsStore)
export const useRoutines = (): Routine[] | null => use(routinesStore)
export const useTabs = (): TabsSnapshot => use(tabsStore)
export const useSpend = (): SpendView | null => use(spendStore)
export const useChatList = (): ChatSummary[] | null => use(chatListStore)

/** A chat's companion (the active one without an id); undefined while loading, null once it is known to be deleted. */
export function useCompanion(id: string | null | undefined): Companion | null | undefined {
  const list = useCompanionList()
  if (!id) return list.loaded ? (list.items.find((c) => c.id === list.activeId) ?? null) : undefined
  const found = list.items.find((c) => c.id === id)
  if (found) return found
  return list.loaded ? null : undefined
}
