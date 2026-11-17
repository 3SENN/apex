/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import type { SaveState } from '../ui'

const SAVED_FOR_MS = 1800

/**
 * Save state for one-shot saves (a select, a switch): "Saving…", then
 * "Saved" for a moment, or "Couldn't save" with the last attempt kept for
 * Retry. Only the newest save reports.
 */
export function useSaveTracker(): { state: SaveState; run(save: () => Promise<unknown>): void; retry(): void } {
  const [state, setState] = useState<SaveState>('idle')
  const last = useRef<(() => Promise<unknown>) | null>(null)
  const ticket = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const run = (save: () => Promise<unknown>): void => {
    last.current = save
    const mine = ++ticket.current
    if (timer.current) clearTimeout(timer.current)
    setState('saving')
    save().then(
      () => {
        if (mine !== ticket.current) return
        setState('saved')
        timer.current = setTimeout(() => setState('idle'), SAVED_FOR_MS)
      },
      () => {
        if (mine === ticket.current) setState('error')
      },
    )
  }
  return { state, run, retry: () => last.current && run(last.current) }
}
