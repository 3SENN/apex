/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Live activity-memory state for the chrome: the status (glyph, popover,
// settings banner) and the settings (Settings › Activity memory). Both
// follow main's `activity-status` event, which also fires at each schedule
// edge and when a pause runs out.
import { useCallback, useEffect, useState } from 'react'
import type { ActivitySettings, ActivityStatus } from '@shared/activity'
import { apex, call, errorText } from '../api'

export interface ActivityStatusState {
  status: ActivityStatus | null
  error: string | null
  reload(): void
}

export function useActivityStatus(): ActivityStatusState {
  const [status, setStatus] = useState<ActivityStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback((): void => {
    call('activity', 'status').then(
      (next) => {
        setStatus(next)
        setError(null)
      },
      (err: unknown) => setError(errorText(err)),
    )
  }, [])
  useEffect(() => {
    reload()
    return apex.onAppEvent((event) => {
      if (event.type === 'activity-status') {
        setStatus(event.status)
        setError(null)
      }
    })
  }, [reload])
  return { status, error, reload }
}

export interface ActivitySettingsState {
  settings: ActivitySettings | null
  error: string | null
  /** Saves a change and keeps what main answered (it normalizes and may clean up). */
  update(patch: Partial<ActivitySettings>): Promise<ActivitySettings | null>
  reload(): void
}

export function useActivitySettings(onError?: (message: string) => void): ActivitySettingsState {
  const [settings, setSettings] = useState<ActivitySettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback((): void => {
    setError(null)
    call('activity', 'settings').then(setSettings, (err: unknown) => setError(errorText(err)))
  }, [])
  useEffect(() => {
    reload()
    // A pause or override from the popover changes the settings too.
    return apex.onAppEvent((event) => {
      if (event.type === 'activity-status') void call('activity', 'settings').then(setSettings, () => undefined)
    })
  }, [reload])
  const update = useCallback(
    async (patch: Partial<ActivitySettings>): Promise<ActivitySettings | null> => {
      // Show the change at once; main's answer replaces it.
      setSettings((s) => (s ? { ...s, ...patch } : s))
      try {
        const next = await call('activity', 'update', patch)
        setSettings(next)
        return next
      } catch (err) {
        onError?.(errorText(err))
        reload()
        return null
      }
    },
    [onError, reload],
  )
  return { settings, error, update, reload }
}
