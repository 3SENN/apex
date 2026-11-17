/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react'
import { IDLE_CAPTURE, type CaptureStatus } from '@shared/meetingCapture'
import type { MeetingDetail, MeetingKind, MeetingSummary } from '@shared/meetings'
import { apex, call, errorText } from '../api'
import { useEvent } from '../settings/data'
import { appendSegments } from './logic'

// Live data for apex://meetings: the list (kept in step with 'meetings'),
// one meeting (with 'meeting-live' lines as they arrive) and the recorder's
// status for the live row and the start pill.

export interface ListState {
  items: MeetingSummary[] | null
  error: string | null
  reload(): Promise<void>
}

/** The list for one kind and search; a search goes back to main, which also looks through transcripts. */
export function useMeetingList(kind: MeetingKind, query: string): ListState {
  const [items, setItems] = useState<MeetingSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const q = query.trim()

  const load = async (): Promise<void> => {
    const mine = ++generation.current
    try {
      const next = await call('meetings', 'list', { kind, ...(q ? { query: q } : {}) })
      if (mine !== generation.current) return
      setItems(next)
      setError(null)
    } catch (err) {
      if (mine === generation.current) setError(errorText(err))
    }
  }

  // Search as you type, a beat after the last key; the old rows stay until the new ones arrive.
  useEffect(() => {
    const timer = setTimeout(() => void load(), q ? 180 : 0)
    return () => clearTimeout(timer)
  }, [kind, q])

  const refresh = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEvent('meetings', (e) => {
    if (!q) {
      generation.current++
      setItems(e.items.filter((m) => m.kind === kind))
      setError(null)
      return
    }
    if (refresh.current) clearTimeout(refresh.current)
    refresh.current = setTimeout(() => void load(), 250)
  })
  useEffect(() => () => {
    if (refresh.current) clearTimeout(refresh.current)
  }, [])

  return { items, error, reload: load }
}

export interface DetailState {
  meeting: MeetingDetail | null
  error: string | null
  /** The meeting was deleted while open. */
  gone: boolean
  reload(): Promise<void>
}

export function useMeetingDetail(id: string): DetailState {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gone, setGone] = useState(false)
  const latest = useRef<MeetingDetail | null>(null)
  latest.current = meeting

  const load = async (): Promise<void> => {
    try {
      const next = await call('meetings', 'get', id)
      setMeeting(next)
      setError(null)
      setGone(false)
    } catch (err) {
      setError(errorText(err))
    }
  }

  useEffect(() => {
    setMeeting(null)
    setGone(false)
    void load()
  }, [id])

  useEvent('meeting-live', (e) => {
    if (e.id !== id) return
    setMeeting((m) => (m ? { ...m, segments: appendSegments(m.segments, e.appended), live: e.live, status: e.status } : m))
  })

  // Titles, summaries, labels and progress come with the list; reload when this meeting's row changed.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEvent('meetings', (e) => {
    const row = e.items.find((m) => m.id === id)
    const current = latest.current
    if (!row) {
      if (current) setGone(true)
      return
    }
    if (!current) return
    const sameLabels = !row.labels || (row.labels.mic === current.labels.mic && row.labels.system === current.labels.system)
    if (!sameLabels) {
      setMeeting({ ...current, labels: { ...row.labels! } })
      return
    }
    // Recording switched to audio only (this Mac couldn't transcribe), or a transcribe made it an ordinary meeting.
    const sameAudioOnly = (row.audioOnly ?? null) === (current.audioOnly ?? null)
    if (sameAudioOnly && row.title === current.title && row.status === current.status && row.hasAudio === current.hasAudio && (row.progress ?? null) === (current.progress ?? null) && row.snippet === current.snippet) return
    // Progress alone needs no full reload.
    if (sameAudioOnly && row.title === current.title && row.status === current.status && row.snippet === current.snippet && row.hasAudio === current.hasAudio) {
      setMeeting({ ...current, progress: row.progress ?? null })
      return
    }
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
    reloadTimer.current = setTimeout(() => void load(), 120)
  })
  useEffect(() => () => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current)
  }, [])

  return { meeting, error, gone, reload: load }
}

/** The recorder's status, live. */
export function useCaptureStatus(): CaptureStatus {
  const [status, setStatus] = useState<CaptureStatus>(IDLE_CAPTURE)
  useEffect(() => {
    let alive = true
    void call('meetingCapture', 'status').then((s) => alive && setStatus(s), () => undefined)
    const off = apex.onAppEvent((e) => {
      if (e.type === 'meeting-capture') setStatus(e.status)
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}
