/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageKey } from '@shared/i18n/core'
import type { MeetingKind, MeetingStatus, MeetingSummary, TranscriptSegment } from '@shared/meetings'

// Pure rules behind atelier://meetings: reading its address, labels for each
// status, the audio clock, which transcript line is playing, and how the
// transcript groups into bubbles.

export type MeetingsFilter = 'meetings' | 'recordings'

/** atelier://meetings?filter=recordings&q=<text>: the segment and search the page opens with. */
export function readMeetingsQuery(url: string): { filter: MeetingsFilter; q: string } {
  const query = url.split('?')[1]?.split('#')[0] ?? ''
  const params = new URLSearchParams(query)
  return { filter: params.get('filter') === 'recordings' ? 'recordings' : 'meetings', q: (params.get('q') ?? '').slice(0, 200) }
}

export function kindFor(filter: MeetingsFilter): MeetingKind {
  return filter === 'recordings' ? 'recording' : 'meeting'
}

/** 1:05, 12:40, 1:02:03. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** A status as the row shows it: a short word and a tone; null for a plain finished meeting. */
export function statusBadge(status: MeetingStatus): { label: MessageKey; tone: 'live' | 'busy' | 'warn' | 'error' | 'quiet' } | null {
  switch (status) {
    case 'live':
      return { label: 'meetings.status.live', tone: 'live' }
    case 'finishing':
      return { label: 'meetings.status.finishing', tone: 'busy' }
    case 'recorded':
      return { label: 'meetings.status.audioOnly', tone: 'quiet' }
    case 'summarizing':
      return { label: 'meetings.status.summarizing', tone: 'busy' }
    case 'summary-pending':
      return { label: 'meetings.status.pending', tone: 'warn' }
    case 'failed':
      return { label: 'meetings.status.failed', tone: 'error' }
    default:
      return null
  }
}

/**
 * Which actions a row offers (MV-12). A meeting recorded as audio only has
 * no transcript yet: it can be transcribed, played and exported as audio,
 * and has nothing to summarise, attach or export as text.
 */
export function rowActions(m: Pick<MeetingSummary, 'status' | 'hasAudio'>): { summarize: boolean; retranscribe: boolean; attach: boolean; exportMarkdown: boolean; exportAudio: boolean; remove: boolean } {
  const settled = m.status !== 'live' && m.status !== 'finishing'
  const recorded = m.status === 'recorded'
  return {
    summarize: settled && m.status !== 'summarizing' && m.status !== 'failed' && !recorded,
    retranscribe: (m.status === 'failed' || recorded) && m.hasAudio,
    attach: m.status !== 'failed' && !recorded,
    exportMarkdown: !recorded,
    exportAudio: settled && m.hasAudio,
    remove: settled,
  }
}

/** The transcribe action's label: the first time for audio only, again after a failure. */
export function transcribeLabel(status: MeetingStatus): MessageKey {
  return status === 'recorded' ? 'meetings.row.transcribe' : 'meetings.row.retranscribe'
}

/** The transcript line playing at `ms`: the last one that has started. -1 before the first. */
export function activeSegment(segments: readonly Pick<TranscriptSegment, 'startMs' | 'endMs'>[], ms: number): number {
  let lo = 0
  let hi = segments.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((segments[mid]?.startMs ?? Infinity) <= ms) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

export interface TranscriptRun {
  source: TranscriptSegment['source']
  /** Index of the first segment in the run. */
  start: number
  segments: TranscriptSegment[]
}

/** Consecutive lines from the same source share one label, like a chat. */
export function transcriptRuns(segments: readonly TranscriptSegment[]): TranscriptRun[] {
  const runs: TranscriptRun[] = []
  segments.forEach((s, i) => {
    const last = runs[runs.length - 1]
    if (last && last.source === s.source) last.segments.push(s)
    else runs.push({ source: s.source, start: i, segments: [s] })
  })
  return runs
}

/** Merges a live update into a detail's segments, skipping any already there. */
export function appendSegments(current: readonly TranscriptSegment[], appended: readonly TranscriptSegment[]): TranscriptSegment[] {
  if (appended.length === 0) return [...current]
  const seen = new Set(current.map((s) => s.id))
  return [...current, ...appended.filter((s) => !seen.has(s.id))]
}

/** A size for humans: 820 KB, 14.2 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
