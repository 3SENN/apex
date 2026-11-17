/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { FirstWeekView } from '@shared/firstWeek'
import { call, useAppEvent } from '../api'

/**
 * The getting-started view, kept live. It reloads when the window regains
 * focus or the page becomes visible, so the default-browser check (which can
 * change outside Apex) reruns on every return to the page.
 */
export function useFirstWeek(): [FirstWeekView | null, (view: FirstWeekView) => void, Error | null] {
  const [view, setView] = useState<FirstWeekView | null>(null)
  const [error, setError] = useState<Error | null>(null)
  useEffect(() => {
    let live = true
    const load = (): void => {
      call('firstWeek', 'view').then(
        (next) => {
          if (!live) return
          setView(next)
          setError(null)
        },
        (err: unknown) => live && setError(err instanceof Error ? err : new Error(String(err))),
      )
    }
    load()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load()
    }
    window.addEventListener('focus', load)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      window.removeEventListener('focus', load)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  useAppEvent('first-week', (event) => setView(event.view))
  return [view, setView, error]
}
