/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import type { SettingsView } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { apex, errorText } from '../api'

export interface Loaded<T> {
  data: T | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
  reload(): void
}

/**
 * Loads data for a card tab and keeps it current. `refresh` looks at each
 * app event: return `{ data }` to take the event's copy, true to load
 * again, or false to ignore it. Only the newest load reports.
 */
export function useLoaded<T>(load: () => Promise<T>, deps: readonly unknown[], refresh?: (event: AppEvent) => { data: T } | boolean): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, 'reload'>>({ data: null, status: 'loading', error: null })
  const ticket = useRef(0)
  const loader = useRef(load)
  loader.current = load
  const refresher = useRef(refresh)
  refresher.current = refresh

  const reload = (): void => {
    const mine = ++ticket.current
    setState((s) => (s.status === 'error' ? { ...s, status: 'loading', error: null } : s))
    loader.current().then(
      (data) => mine === ticket.current && setState({ data, status: 'ready', error: null }),
      (err: unknown) => mine === ticket.current && setState((s) => ({ ...s, status: 'error', error: errorText(err) })),
    )
  }

  useEffect(() => {
    setState({ data: null, status: 'loading', error: null })
    reload()
    return apex.onAppEvent((event) => {
      const verdict = refresher.current?.(event) ?? false
      if (verdict === true) reload()
      else if (verdict !== false) {
        ticket.current++
        setState({ data: verdict.data, status: 'ready', error: null })
      }
    })
  }, deps)

  return { ...state, reload }
}

/** The global settings (default model and effort, API key state), kept live. */
export function useSettingsView(): SettingsView | null {
  const { data } = useLoaded(() => apex.settings.get(), [], (e) => (e.type === 'settings' ? { data: e.view } : false))
  return data
}
