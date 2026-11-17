/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { MeetingStatus, MeetingSummary } from '@shared/meetings'
import { apex, call } from '../api'

// Every meeting's status and title as the chrome last heard them, kept live
// from the 'meetings' and 'meeting-live' events. The composer's meeting chip
// and the waiting chip (MV-14) read it, and so does the sidebar's recording dot.

const known = new Map<string, Pick<MeetingSummary, 'status' | 'title'>>()
const listeners = new Set<() => void>()
let started = false
let version = 0

function emit(): void {
  version++
  for (const fn of [...listeners]) fn()
}

function fill(items: readonly MeetingSummary[]): void {
  known.clear()
  for (const m of items) known.set(m.id, { status: m.status, title: m.title })
  emit()
}

function start(): void {
  if (started) return
  started = true
  apex.onAppEvent((e) => {
    if (e.type === 'meetings') fill(e.items)
    else if (e.type === 'meeting-live') {
      const before = known.get(e.id)
      if (before && before.status !== e.status) {
        known.set(e.id, { ...before, status: e.status })
        emit()
      }
    }
  })
  void call('meetings', 'list').then(fill, () => undefined)
}

export function meetingStatus(id: string): MeetingStatus | null {
  start()
  return known.get(id)?.status ?? null
}

export function meetingTitle(id: string): string | null {
  start()
  return known.get(id)?.title ?? null
}

/** Whether any meeting is being recorded right now (the sidebar's dot). */
export function anyLive(): boolean {
  start()
  for (const m of known.values()) if (m.status === 'live') return true
  return false
}

export function subscribeMeetingStatus(fn: () => void): () => void {
  start()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-renders on any status change; returns a counter that changes with them. */
export function useMeetingStatusVersion(): number {
  return useSyncExternalStore(subscribeMeetingStatus, () => version)
}

export function useMeetingLive(): boolean {
  return useSyncExternalStore(subscribeMeetingStatus, anyLive)
}
