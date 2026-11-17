/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE } from '@shared/ipc'
import type { QueryStates } from '@shared/permissions'

// What a page reads about its own permissions (permissions pass). Electron's
// check handler can only say yes or no, so a site never asked reads 'denied'
// from navigator.permissions.query and Notification.permission, and many
// sites then never ask at all. Main sends this frame's states (QUERY_NAMES in
// shared/permissions.ts: 'prompt' for never asked) at document start and again
// when an answer changes; in the page's world, query keeps returning
// Chromium's own PermissionStatus, whose state reads Apex's answer and whose
// change event fires when it moves. Names Apex doesn't decide stay Chromium's.
// Every frame gets it, except on the account sign-in pages (signInHosts.ts),
// whose world stays Chromium's.

export interface Bridge {
  states(): QueryStates
  onChange(fn: (states: QueryStates) => void): void
}

/** Runs in the page's world; `bridge` is the only thing it reaches back to. Exported for tests. */
export function override(bridge: Bridge): void {
  type Ctor = (abstract new (...args: never[]) => object) & { prototype: object }
  const g = globalThis as unknown as {
    Permissions?: Ctor
    PermissionStatus?: Ctor
    Notification?: Ctor
    WeakRef?: new <T extends object>(target: T) => { deref(): T | undefined }
  }
  if (typeof g.Permissions !== 'function' || typeof g.PermissionStatus !== 'function' || typeof g.WeakRef !== 'function') return
  const queryDesc = Object.getOwnPropertyDescriptor(g.Permissions.prototype, 'query')
  const stateDesc = Object.getOwnPropertyDescriptor(g.PermissionStatus.prototype, 'state')
  if (typeof queryDesc?.value !== 'function' || typeof stateDesc?.get !== 'function') return
  const WeakRefCtor = g.WeakRef
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

  let current: QueryStates = bridge.states()
  /** Statuses query handed out for names Apex decides, and the name each is for. */
  const named = new WeakMap<object, string>()
  const handedOut = new Set<{ deref(): object | undefined }>()

  // Proxies keep the natives' names, lengths and "[native code]" source.
  const query = new Proxy(queryDesc.value as (...args: unknown[]) => Promise<object>, {
    apply(target, self, args) {
      const result = Reflect.apply(target, self, args) as Promise<object>
      let name = ''
      try {
        const d = args[0] as { name?: unknown } | null | undefined
        name = typeof d?.name === 'string' ? d.name : ''
      } catch {
        return result
      }
      if (!has(current, name)) return result
      return result.then((status) => {
        named.set(status, name)
        handedOut.add(new WeakRefCtor(status))
        return status
      })
    },
  })
  Object.defineProperty(g.Permissions.prototype, 'query', { ...queryDesc, value: query })

  const stateGet = new Proxy(stateDesc.get, {
    apply(target, self, args) {
      const name = typeof self === 'object' && self !== null ? named.get(self) : undefined
      return name !== undefined && has(current, name) ? current[name] : Reflect.apply(target, self, args)
    },
  })
  Object.defineProperty(g.PermissionStatus.prototype, 'state', { ...stateDesc, get: stateGet })

  const N = g.Notification
  const permDesc = typeof N === 'function' ? Object.getOwnPropertyDescriptor(N, 'permission') : undefined
  if (N && typeof permDesc?.get === 'function') {
    const permGet = new Proxy(permDesc.get, {
      apply(target, self, args) {
        const s = current.notifications
        return s === 'prompt' ? 'default' : (s ?? Reflect.apply(target, self, args))
      },
    })
    Object.defineProperty(N, 'permission', { ...permDesc, get: permGet })
  }

  bridge.onChange((next) => {
    const before = current
    current = next
    for (const ref of [...handedOut]) {
      const status = ref.deref()
      if (!status) {
        handedOut.delete(ref)
        continue
      }
      const name = named.get(status)
      if (name !== undefined && before[name] !== next[name]) (status as EventTarget).dispatchEvent(new Event('change'))
    }
  })
}

const STATES = new Set(['granted', 'denied', 'prompt'])

/** A well-formed states object from main, or null. */
function parse(value: unknown): QueryStates | null {
  if (!value || typeof value !== 'object') return null
  const out: QueryStates = {}
  for (const [name, state] of Object.entries(value as Record<string, unknown>)) {
    if (typeof state === 'string' && STATES.has(state)) out[name] = state as QueryStates[string]
  }
  return out
}

export function installPermissionStatus(): void {
  let states: QueryStates | null = null
  try {
    states = parse(ipcRenderer.sendSync(PAGE.permissions))
  } catch {
    // Main didn't answer (a page outside a tab); the page keeps Chromium's answers.
  }
  if (!states) return
  let listener: ((states: QueryStates) => void) | null = null
  ipcRenderer.on(PAGE.permissions, (_event, next: unknown) => {
    const parsed = parse(next)
    if (!parsed) return
    states = parsed
    try {
      listener?.(parsed)
    } catch {
      // The page's world went away with its document.
    }
  })
  const bridge: Bridge = {
    states: () => states ?? {},
    // Only the override above subscribes, once.
    onChange: (fn) => {
      listener ??= fn
    },
  }
  try {
    contextBridge.executeInMainWorld({ func: override, args: [bridge] })
  } catch {
    // A world that can't be reached keeps Chromium's answers.
  }
}
