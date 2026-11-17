/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { AppEvent } from '@shared/services'
import { apex } from '../../api'
import { useLatest } from '../../ui'

// Small hooks over main's app events for the sidebar's key-state and drag
// events: number hints, edge reveal and the tab drag.

type EventOf<K extends AppEvent['type']> = Extract<AppEvent, { type: K }>

/** Calls `handler` for each event of `type`; the handler can change between renders. */
export function useAppEvent<K extends AppEvent['type']>(type: K, handler: (event: EventOf<K>) => void): void {
  const latest = useLatest(handler)
  useEffect(
    () =>
      apex.onAppEvent((event) => {
        if (event.type === type) latest.current?.(event as EventOf<K>)
      }),
    [type, latest],
  )
}

/** ⌘ held: the 1–8 hints show (SH-22). Blur hides them too, in case the release was missed. */
export function useNumberHints(): boolean {
  const [shown, setShown] = useState(false)
  useAppEvent('number-hints', (e) => setShown(e.show))
  useEffect(() => {
    const hide = (): void => setShown(false)
    window.addEventListener('blur', hide)
    return () => window.removeEventListener('blur', hide)
  }, [])
  return shown
}

/** A tab drag is under way in some window (SH-30): rows stop reacting and hover cards stay closed. */
export function useTabDragActive(): boolean {
  const [active, setActive] = useState(false)
  useAppEvent('tab-drag', (e) => setActive(e.active))
  return active
}
