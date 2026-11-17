/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updates'
import { apex, call } from '../api'

// The live update status: loaded once from main, then kept current by the
// 'update' app event. Null until the first answer (and if updates aren't
// wired in this build, which reads as "no update UI").

let cached: UpdateStatus | null = null

export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(cached)
  useEffect(() => {
    let live = true
    const off = apex.onAppEvent((event) => {
      if (event.type !== 'update') return
      cached = event.status
      setStatus(event.status)
    })
    call('updates', 'status').then(
      (s) => {
        cached = s
        if (live) setStatus(s)
      },
      () => {
        // Not wired in this run: no update UI.
      },
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return status
}
