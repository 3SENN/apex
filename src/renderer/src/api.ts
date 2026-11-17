/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { AppEvent } from '@shared/services'
import { t } from '@shared/i18n/core'

// Read window.apex on each use, not at load: the floats' page (float.html)
// shares chunks with the chrome and gets its stand-in (voice/floatShim.ts)
// only after those chunks have run, so a load-time read stopped it drawing.
export const apex: Window['apex'] = new Proxy({} as Window['apex'], {
  get: (_target, key) => (window.apex as unknown as Record<PropertyKey, unknown> | undefined)?.[key],
})
export const call: Window['apex']['invoke'] = ((...args: Parameters<Window['apex']['invoke']>) => window.apex.invoke(...args)) as Window['apex']['invoke']

/** Subscribes to one kind of app event from main. */
export function useAppEvent<T extends AppEvent['type']>(type: T, listener: (event: Extract<AppEvent, { type: T }>) => void): void {
  useEffect(
    () =>
      apex.onAppEvent((event) => {
        if (event.type === type) listener(event as Extract<AppEvent, { type: T }>)
      }),
    // The listener is captured once per event type.
    [type],
  )
}

/** Loads a list once and keeps it in sync with its change event. */
export function useLiveList<T, E extends AppEvent['type']>(load: () => Promise<T[]>, event: E, pick: (e: Extract<AppEvent, { type: E }>) => T[]): [T[], () => void] {
  const [items, setItems] = useState<T[]>([])
  const reload = (): void => {
    void load().then(setItems)
  }
  useEffect(reload, [])
  useAppEvent(event, (e) => setItems(pick(e)))
  return [items, reload]
}

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in main with the channel name.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return t('core.api.minAgo', { value: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('core.api.hAgo', { value: Math.floor(diff / 3_600_000) })
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
