/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// App.tsx's hook into spaces: the window's tab snapshot,
// narrowed to the current space's tabs. Everything downstream (sidebar,
// strip, toolbar) then shows only that space.
import { useMemo } from 'react'
import type { TabsSnapshot } from '@shared/ipc'
import { useSpaces } from './data'
import { spaceView } from './logic'

export function useSpaceSnapshot(snapshot: TabsSnapshot): TabsSnapshot {
  const spaces = useSpaces()
  return useMemo(() => spaceView(snapshot, spaces), [snapshot, spaces])
}
