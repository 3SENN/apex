/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react'
import type { ExtensionInfo } from '@shared/extensions'
import { call, errorText, useAppEvent } from '../api'

// The profile's extensions, kept live by main's `extensions` event.
// Loading, error and loaded states, so every surface can draw each one.

export interface ExtensionsState {
  items: ExtensionInfo[]
  loading: boolean
  error: string | null
  reload(): Promise<void>
}

export function useExtensions(): ExtensionsState {
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setItems(await call('extensions', 'list'))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useAppEvent('extensions', (event) => {
    setItems(event.items)
    setLoading(false)
    setError(null)
  })

  return { items, loading, error, reload }
}

// The pure filters live in @shared/extensions; re-exported for the surfaces that already import them here.
export { filterExtensions, toolbarButtons } from '@shared/extensions'
