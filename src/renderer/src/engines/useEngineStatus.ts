/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { EngineStatus } from '@shared/engine'
import { call, useAppEvent } from '../api'

/** The engine status, live: loaded once, then kept current by 'engine' events. */
export function useEngineStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  useEffect(() => {
    let alive = true
    void call('engine', 'status').then((next) => alive && setStatus(next))
    return () => {
      alive = false
    }
  }, [])
  useAppEvent('engine', (event) => setStatus(event.status))
  return status
}
