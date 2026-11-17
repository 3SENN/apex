/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The meetings library: finished and live meetings and recordings,
// their transcripts, summaries and audio. Files live at
// userData/meetings/<id>/{meta.json, transcript.jsonl, summary.json, audio.m4a}.
// Meeting capture writes live meetings through MeetingStore.
import type { MeetingProvider } from './meetingCapture'
import type { SpeechErrorCode, SpeechSource } from './speech'

export type MeetingKind = 'meeting' | 'recording'

/** 'recorded': kept as audio only, with no transcript (yet). */
export type MeetingStatus = 'live' | 'finishing' | 'recorded' | 'transcribed' | 'summarizing' | 'summarized' | 'summary-pending' | 'failed'

/**
 * Why a meeting is recorded as audio only: you chose Record audio only, or
 * this Mac couldn't transcribe it (Speech Recognition is off for Atelier, or the
 * language isn't supported), so Atelier recorded the audio instead of failing.
 */
export type AudioOnlyReason = 'chosen' | 'speech-denied' | 'locale-unsupported'

/** The audio-only reason a failed transcription start falls back to; null when recording can't help either. */
export function audioOnlyFallback(code: SpeechErrorCode): AudioOnlyReason | null {
  return code === 'speech-denied' || code === 'locale-unsupported' ? code : null
}

export type MeetingWarning = 'screen-missing' | 'device-fallback' | 'interrupted'

/** Statuses whose transcript can still change; an attached meeting is held until it leaves them (MV-14). */
export const UNSETTLED_STATUSES: readonly MeetingStatus[] = ['live', 'finishing']

export interface TranscriptSegment {
  id: string
  source: SpeechSource
  text: string
  /** Audio time in ms, pauses excluded. */
  startMs: number
  endMs: number
}

export interface MeetingSummary {
  id: string
  kind: MeetingKind
  title: string
  provider: MeetingProvider | null
  url: string | null
  startedAt: number
  durationMs: number
  status: MeetingStatus
  hasAudio: boolean
  sizeBytes: number
  snippet: string
  /** 0..1 while the meeting is transcribed again from its audio; null or absent otherwise. */
  progress?: number | null
  /** Speaker labels, so an open meeting page hears a rename made elsewhere. */
  labels?: { mic: string; system: string }
  /** Recorded as audio only, and why; absent or null once it has a transcript. */
  audioOnly?: AudioOnlyReason | null
}

export interface MeetingNotes {
  title: string
  summary: string
  takeaways: string[]
  decisions: string[]
  actionItems: { text: string; owner?: string }[]
  participants: string[]
}

export interface MeetingDetail extends MeetingSummary {
  segments: TranscriptSegment[]
  live: Partial<Record<SpeechSource, string>>
  /** Speaker labels; 'You' and 'Others' until renamed. */
  labels: { mic: string; system: string }
  summary: MeetingNotes | null
  /** atelier-media://meeting/<id>/audio */
  audioUrl: string | null
  error: SpeechErrorCode | null
  warnings: MeetingWarning[]
}

export interface MeetingListFilter {
  query?: string
  kind?: MeetingKind
}

// ── main-side interfaces (implemented in src/main/meetings/**) ──

export interface MeetingCreateInput {
  kind: MeetingKind
  title: string
  url?: string | null
  provider?: MeetingProvider | null
  locale: string
  startedAt: number
  recordAudio: boolean
  /** Record audio only (the audio is always kept). */
  audioOnly?: AudioOnlyReason | null
}

export interface MeetingFinish {
  endedAt: number
  durationMs: number
  audio: { path: string; bytes: number } | null
  /** 'recorded' for audio only; without audio it becomes a failure. */
  status: 'recorded' | 'transcribed' | 'failed'
  error?: SpeechErrorCode
}

export interface MeetingStore {
  create(i: MeetingCreateInput): MeetingSummary
  audioPathFor(id: string): string
  appendSegment(id: string, s: Omit<TranscriptSegment, 'id'>): void
  setLive(id: string, live: Partial<Record<SpeechSource, string>>): void
  warn(id: string, w: MeetingWarning): void
  /** A meeting that couldn't be transcribed records audio only from the start (it keeps the audio). */
  setAudioOnly(id: string, reason: AudioOnlyReason): void
  finish(id: string, r: MeetingFinish): void
  get(id: string): MeetingDetail | null
  on(event: 'changed', fn: (id: string) => void): unknown
}

export interface MeetingSummarizer {
  request(id: string, o?: { companionId?: string }): Promise<void>
  pending(): string[]
}

export interface MeetingResolver {
  /** The text a chat gets for an attached meeting; `ready` is false until the transcript is final (MV-14). */
  forPrompt(id: string): Promise<{ title: string; text: string; ready: boolean }>
}


export interface MeetingsServices {
  meetings: {
    list(f?: MeetingListFilter): MeetingSummary[]
    get(id: string): MeetingDetail
    rename(id: string, title: string): void
    renameLabel(id: string, source: SpeechSource, label: string): void
    summarize(id: string): Promise<void>
    retranscribe(id: string): Promise<void>
    /** Saves through a save dialog; resolves to the path, or null when cancelled. */
    exportFile(id: string, format: 'markdown' | 'audio'): Promise<string | null>
    remove(id: string): void
    storage(): { bytes: number; count: number }
    /** Starts a chat about the meeting; resolves to its id. */
    discuss(id: string, companionId?: string): Promise<string>
  }
}

export type MeetingsAppEvent =
  | { type: 'meetings'; items: MeetingSummary[] }
  | { type: 'meeting-live'; id: string; appended: TranscriptSegment[]; live: Partial<Record<SpeechSource, string>>; status: MeetingStatus }

export const MEETING_TITLE_MAX = 200
export const MEETING_LABEL_MAX = 40
