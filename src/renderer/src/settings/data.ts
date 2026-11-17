/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Data hooks for settings and destination pages: a loaded value with its
// loading and error state, kept live by an app event.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, Companion } from '@shared/services'
import { atelier, call, errorText } from '../api'
import { useLatest } from '../ui'
import { skeletonHoldLeft } from '../ui/logic/skeleton'

export interface Resource<T> {
  /** null until the first load succeeds. */
  data: T | null
  error: string | null
  loading: boolean
  /** Loads again; resolves when done (failures land in `error`). */
  reload(): Promise<void>
  /** Replaces the value, e.g. from an app event. */
  set(data: T): void
}

/**
 * Loads once on mount (and when `key` changes); a later failure keeps the
 * last value. With `keep`, a new key keeps showing the old value until the
 * new one arrives (search as you type).
 */
export function useResource<T>(load: () => Promise<T>, key: unknown = null, { keep = false }: { keep?: boolean } = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const loader = useLatest(load)
  const generation = useRef(0)
  /** Whether a value is showing; with none, the page shows a skeleton while it loads. */
  const hasData = useRef(false)
  const reload = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    const started = performance.now()
    setLoading(true)
    try {
      const value = await loader.current()
      // DS-106: a skeleton that came up stays at least ~100 ms, so it never blinks.
      const hold = hasData.current ? 0 : skeletonHoldLeft(performance.now() - started)
      if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold))
      if (mine !== generation.current) return
      hasData.current = true
      setData(value)
      setError(null)
    } catch (err) {
      if (mine === generation.current) setError(errorText(err))
    } finally {
      if (mine === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!keep) {
      setData(null)
      hasData.current = false
    }
    void reload()
    return () => {
      generation.current++
    }
  }, [key])
  const set = useCallback((value: T) => {
    generation.current++
    hasData.current = true
    setData(value)
    setError(null)
    setLoading(false)
  }, [])
  return { data, error, loading, reload, set }
}

/** Calls the listener for each app event of one type; the latest listener is used. */
export function useEvent<T extends AppEvent['type']>(type: T, listener: (event: Extract<AppEvent, { type: T }>) => void): void {
  const latest = useLatest(listener)
  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type === type) latest.current(event as Extract<AppEvent, { type: T }>)
      }),
    [type],
  )
}

export interface CompanionsState {
  items: Companion[] | null
  activeId: string | null
  error: string | null
  reload(): Promise<void>
}

/** Every companion (hidden ones included) and the active one, kept live. */
export function useCompanions(): CompanionsState {
  const resource = useResource(async () => {
    const [items, activeId] = await Promise.all([call('companions', 'list'), call('companions', 'activeId')])
    return { items, activeId }
  })
  useEvent('companions', (e) => resource.set({ items: e.items, activeId: e.activeId }))
  return { items: resource.data?.items ?? null, activeId: resource.data?.activeId ?? null, error: resource.error, reload: resource.reload }
}

/** A value that sticks to the latest list from main, for lists with a change event. */
export function useLiveResource<T, E extends AppEvent['type']>(load: () => Promise<T>, event: E, pick: (e: Extract<AppEvent, { type: E }>) => T): Resource<T> {
  const resource = useResource(load)
  useEvent(event, (e) => resource.set(pick(e)))
  return resource
}

/** Reads and writes a small per-viewer preference; storage can be missing or blocked. */
export function useLocalPreference<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored !== null && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback
    } catch {
      return fallback
    }
  })
  const update = useCallback((next: T) => {
    setValue(next)
    try {
      window.localStorage.setItem(key, next)
    } catch {
      // Not remembered this time; the choice still applies.
    }
  }, [key])
  return [value, update]
}
