/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SHARED_OWNER } from '@shared/chats'
import type { EngineStatus } from '@shared/engine'
import type { AppEvent, Services } from '@shared/services'
import type { CompanionStore } from './companions'
import { FirstWeekStore, companionFingerprint } from './firstWeek'
import { curatedStarters, generateStarters, type StarterContext, type StarterQuick } from './firstWeekStarters'
import type { HistoryStore } from './history'
import type { MemoryService } from './memory'
import type { SettingsStore } from './settings'
import type { ConnectorStore, RoutineStore } from './stores'

// Wires the getting-started store to the rest of main: what each signal
// reads, when the view is pushed to the chrome, and the starter call.

export interface FirstWeekWiring {
  dataDir: string
  settings: SettingsStore
  companions: CompanionStore
  connectors: ConnectorStore
  routines: RoutineStore
  memory: MemoryService
  history: HistoryStore
  sendEvent(event: AppEvent): void
  /** The live default-browser check. */
  isDefaultBrowser(): boolean
  /** Asks the system to make Apex the default browser; throws a readable error when it can't. */
  makeDefaultBrowser(): void
  /** The app's QuickModel for the starter call, on either engine; omitted (smoke runs) means curated starters only. */
  quick?: StarterQuick
  /** Engine status changes (another engine found or signed in): a starter call that had no engine tries again. */
  engines?: { on(event: 'changed', listener: (status: EngineStatus) => void): unknown }
}

/** Short excerpts of the newest notes the active companion can read. */
function memoryExcerpts(memory: MemoryService, companionId: string): string[] {
  const files = [...memory.list(companionId), ...memory.list(SHARED_OWNER)].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 4)
  const out: string[] = []
  for (const file of files) {
    try {
      const text = memory.read(file.path, file.owner).slice(0, 400).trim()
      if (text) out.push(`${file.path.replace(/^\/memories\//, '')}: ${text}`)
    } catch {
      // A note that vanished or can't be read is simply skipped.
    }
  }
  return out
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function setupFirstWeek(w: FirstWeekWiring): { store: FirstWeekStore; services: Pick<Services, 'firstWeek'> } {
  const context = (): StarterContext => {
    const active = w.companions.get()
    return {
      userName: w.settings.get().userName,
      companionName: active.name,
      instructions: active.instructions,
      memoryNotes: memoryExcerpts(w.memory, active.id),
      connectors: w.connectors.views().filter((c) => c.enabled).map((c) => c.name),
      recentSites: w.history.search('', 60).filter((h) => /^https?:/i.test(h.url)).map((h) => hostOf(h.url)).filter(Boolean),
    }
  }
  const quick = w.quick
  const store = new FirstWeekStore(w.dataDir, {
    live: () => ({
      'default-browser': w.isDefaultBrowser(),
      'connect-app': w.connectors.views().some((c) => c.enabled),
      'set-up-routine': w.routines.list().length > 0,
      // Dictation completes through the transcription-ready signal (store.signal), so the live check stays false.
      'try-dictation': false,
    }),
    companions: () => w.companions.list().map((c) => ({ id: c.id, fingerprint: companionFingerprint(c) })),
    onboarded: () => w.settings.get().onboarded,
    curatedStarters,
    // null with no engine ready (try again once one is); [] when the call failed (not retried).
    ...(quick
      ? {
          personalStarters: async (signal: AbortSignal) => {
            if (!(await quick.ready()).ok) return null
            // An engine that goes away mid-call rejects, which the store also treats as "try again later".
            return (await generateStarters(quick, context(), signal)) ?? []
          },
        }
      : {}),
  })
  store.on('changed', (view) => w.sendEvent({ type: 'first-week', view }))
  // Signals that depend on other stores push a fresh view when those change.
  w.connectors.on('changed', () => store.refresh())
  w.routines.on('changed', () => store.refresh())
  w.companions.on('changed', () => store.refresh())
  // A key saved, or the engine switched, after setup can still write personal starters.
  w.settings.on('changed', () => store.retryPersonal())
  // So can another engine once it is set up (found and signed in; only on that change, so the page doesn't flicker).
  let othersReady = new Set<string>()
  w.engines?.on('changed', (status) => {
    const ready = new Set(status.others.filter((o) => o.ready).map((o) => o.id as string))
    if ([...ready].some((id) => !othersReady.has(id))) store.retryPersonal()
    othersReady = ready
  })

  const services: Pick<Services, 'firstWeek'> = {
    firstWeek: {
      view: () => store.view(),
      setDone: (id, done) => store.setDone(id, done),
      dismiss: (id) => store.dismiss(id),
      restore: (id) => store.restore(id),
      dismissAll: () => store.dismissAll(),
      snooze: () => store.snooze(),
      unsnooze: () => store.unsnooze(),
      hide: (reason, note) => store.hide(reason, note),
      show: () => store.show(),
      acknowledge: () => store.acknowledge(),
      makeDefaultBrowser: () => {
        w.makeDefaultBrowser()
        return store.view()
      },
    },
  }
  return { store, services }
}

