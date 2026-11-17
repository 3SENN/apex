/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MeetingProvider } from '@shared/meetingCapture'
import {
  MEETING_LABEL_MAX,
  MEETING_TITLE_MAX,
  UNSETTLED_STATUSES,
  type AudioOnlyReason,
  type MeetingCreateInput,
  type MeetingDetail,
  type MeetingFinish,
  type MeetingKind,
  type MeetingListFilter,
  type MeetingNotes,
  type MeetingStatus,
  type MeetingStore,
  type MeetingSummary,
  type MeetingWarning,
  type TranscriptSegment,
} from '@shared/meetings'
import type { SpeechErrorCode, SpeechSource } from '@shared/speech'
import { log } from '../log'
import { writeAtomic } from '../settings'

// The meetings library on disk: one folder per meeting under
// userData/meetings/<id>/ with meta.json, an append-only transcript.jsonl,
// summary.json and, when audio was kept, audio.m4a. The in-memory index is
// rebuilt from the folders at start-up, and a meeting that was still live
// when Atelier quit is recovered there (long meetings, crashes). Its audio
// may still be in the parts the helper writes while recording (hidden
// `.audio.m4a.<source>.<start>.part.aac` files); those are the recording, and
// the library has the helper put them back together (recoverable, recovered).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SNIPPET_MAX = 160
/** Statuses where the transcript can still change; attached meetings wait for these to pass (MV-14). */
export const UNSETTLED: readonly MeetingStatus[] = UNSETTLED_STATUSES

interface Meta {
  v: 1
  id: string
  kind: MeetingKind
  title: string
  /** The person renamed it; a summary title no longer replaces it. */
  titleEdited: boolean
  provider: MeetingProvider | null
  url: string | null
  locale: string
  startedAt: number
  endedAt: number | null
  durationMs: number
  status: MeetingStatus
  recordAudio: boolean
  /** Recorded as audio only, and why; null once it has a transcript. */
  audioOnly: AudioOnlyReason | null
  audioBytes: number
  labels: { mic: string; system: string }
  labelsEdited: { mic: boolean; system: boolean }
  error: SpeechErrorCode | null
  warnings: MeetingWarning[]
}

interface Entry {
  meta: Meta
  segments: TranscriptSegment[]
  live: Partial<Record<SpeechSource, string>>
  summary: MeetingNotes | null
  /** 0..1 while transcribing again from the audio. */
  progress: number | null
  transcriptBytes: number
}

export interface LiveChange {
  id: string
  appended: TranscriptSegment[]
  live: Partial<Record<SpeechSource, string>>
  status: MeetingStatus
}

export interface StoreLabels {
  you: string
  others: string
}

export interface MeetingStoreOptions {
  /** Default speaker labels, in the app's language. */
  labels: StoreLabels
  /** Moves a folder to the Trash; falls back to deleting it when that fails. */
  trash?(path: string): Promise<void>
  now?(): number
}

const KINDS: readonly MeetingKind[] = ['meeting', 'recording']
const STATUSES: readonly MeetingStatus[] = ['live', 'finishing', 'recorded', 'transcribed', 'summarizing', 'summarized', 'summary-pending', 'failed']
const AUDIO_ONLY: readonly AudioOnlyReason[] = ['chosen', 'speech-denied', 'locale-unsupported']
const WARNINGS: readonly MeetingWarning[] = ['screen-missing', 'device-fallback', 'interrupted']

function str(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** A meta.json read back defensively: a hand-edited or half-written file never takes the library down. */
export function readMeta(raw: unknown, id: string, labels: StoreLabels): Meta | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const status = STATUSES.includes(m.status as MeetingStatus) ? (m.status as MeetingStatus) : 'failed'
  const rawLabels = (m.labels && typeof m.labels === 'object' ? m.labels : {}) as Record<string, unknown>
  const edited = (m.labelsEdited && typeof m.labelsEdited === 'object' ? m.labelsEdited : {}) as Record<string, unknown>
  return {
    v: 1,
    id,
    kind: KINDS.includes(m.kind as MeetingKind) ? (m.kind as MeetingKind) : 'meeting',
    title: str(m.title, MEETING_TITLE_MAX).trim() || 'Untitled meeting',
    titleEdited: m.titleEdited === true,
    provider: typeof m.provider === 'string' ? (m.provider as MeetingProvider) : null,
    url: typeof m.url === 'string' ? m.url.slice(0, 2048) : null,
    locale: str(m.locale, 35, 'en-US'),
    startedAt: num(m.startedAt),
    endedAt: typeof m.endedAt === 'number' ? m.endedAt : null,
    durationMs: num(m.durationMs),
    status,
    recordAudio: m.recordAudio === true,
    audioOnly: AUDIO_ONLY.includes(m.audioOnly as AudioOnlyReason) ? (m.audioOnly as AudioOnlyReason) : null,
    audioBytes: num(m.audioBytes),
    labels: {
      mic: str(rawLabels.mic, MEETING_LABEL_MAX).trim() || labels.you,
      system: str(rawLabels.system, MEETING_LABEL_MAX).trim() || labels.others,
    },
    labelsEdited: { mic: edited.mic === true, system: edited.system === true },
    error: typeof m.error === 'string' ? (m.error as SpeechErrorCode) : null,
    warnings: Array.isArray(m.warnings) ? (m.warnings.filter((w) => WARNINGS.includes(w as MeetingWarning)) as MeetingWarning[]) : [],
  }
}

/** transcript.jsonl back into segments; a torn last line (a crash mid-write) is skipped. */
export function parseTranscript(text: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as Partial<TranscriptSegment>
      if ((s.source === 'mic' || s.source === 'system') && typeof s.text === 'string' && typeof s.startMs === 'number' && typeof s.endMs === 'number') {
        out.push({ id: typeof s.id === 'string' ? s.id : randomUUID(), source: s.source, text: s.text, startMs: s.startMs, endMs: s.endMs })
      }
    } catch {
      // A partial line from an interrupted write.
    }
  }
  return out
}

/** Recording parts a session never merged into audio.m4a (a crash, a force quit, a failed merge): AAC on macOS, WAV from Windows' helper. */
const PART = /^\.audio\.m4a\..+\.part\.(aac|m4a|wav)$/i

function hasLeftParts(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => PART.test(name))
  } catch {
    return false
  }
}

/**
 * The settled status after a crash: what was saved is kept. An
 * audio-only meeting is its audio; one whose audio is still in parts waits
 * as 'finishing' until they are put back together (recovered).
 */
export function recoveredStatus(status: MeetingStatus, segments: number, pending: boolean, audio: { only: boolean; kept: boolean; parts?: boolean } = { only: false, kept: false }): MeetingStatus {
  if (status === 'live' || status === 'finishing') {
    if (segments > 0) return 'transcribed'
    if (audio.parts) return 'finishing'
    return audio.only && audio.kept ? 'recorded' : 'failed'
  }
  if (status === 'summarizing') return pending ? 'summary-pending' : 'transcribed'
  return status
}

/** Lowercased words a query must all find, so "budget q3" matches either order. */
export function queryWords(query: string | undefined): string[] {
  return (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesQuery(haystack: string, words: readonly string[]): boolean {
  return words.every((w) => haystack.includes(w))
}

function snippetOf(entry: Entry): string {
  const text = entry.summary?.summary?.trim() || entry.segments.map((s) => s.text).join(' ').trim()
  return text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : text
}

function searchText(entry: Entry): string {
  const s = entry.summary
  const parts = [entry.meta.title, s?.summary ?? '', ...(s?.takeaways ?? []), ...(s?.decisions ?? []), ...(s?.actionItems.map((a) => a.text) ?? []), ...entry.segments.map((x) => x.text)]
  return parts.join('\n').toLowerCase()
}

export class MeetingFileStore extends EventEmitter<{ changed: [id: string]; live: [change: LiveChange]; finished: [id: string] }> implements MeetingStore {
  readonly root: string
  readonly #opts: MeetingStoreOptions
  readonly #entries = new Map<string, Entry>()
  /** Search text per meeting, rebuilt lazily after a change. */
  readonly #search = new Map<string, string>()
  /** Meetings with recording parts left to put back together; `#waiting` ones settle when that's done. */
  readonly #leftBehind = new Set<string>()
  readonly #waiting = new Set<string>()

  constructor(root: string, opts: MeetingStoreOptions) {
    super()
    this.root = root
    this.#opts = opts
    this.setMaxListeners(50)
  }

  /**
   * Rebuilds the index from the folders. `pending` lists meetings the
   * summarizer still owes a summary, so a crash mid-summary resumes there.
   */
  load(pending: readonly string[] = []): void {
    this.#entries.clear()
    this.#search.clear()
    this.#leftBehind.clear()
    this.#waiting.clear()
    mkdirSync(this.root, { recursive: true })
    let names: string[] = []
    try {
      names = readdirSync(this.root)
    } catch (err) {
      log.warn('meetings', 'Reading the meetings folder failed', { error: String(err) })
    }
    for (const id of names) {
      if (!UUID.test(id)) continue
      const dir = join(this.root, id)
      let meta: Meta | null = null
      try {
        meta = readMeta(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')), id, this.#opts.labels)
      } catch {
        meta = null
      }
      if (!meta) continue
      let segments: TranscriptSegment[] = []
      let transcriptBytes = 0
      try {
        const text = readFileSync(join(dir, 'transcript.jsonl'), 'utf8')
        transcriptBytes = Buffer.byteLength(text)
        segments = parseTranscript(text)
      } catch {
        segments = []
      }
      let summary: MeetingNotes | null = null
      try {
        summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as MeetingNotes
      } catch {
        summary = null
      }
      const audio = join(dir, 'audio.m4a')
      // Parts left behind are the recording: an audio.m4a beside them may be half written (merged again once they're put together).
      const parts = hasLeftParts(dir)
      meta.audioBytes = !parts && existsSync(audio) ? statSync(audio).size : 0
      const before = meta.status
      const recovered = recoveredStatus(before, segments.length, pending.includes(id), { only: meta.audioOnly !== null, kept: meta.audioBytes > 0, parts })
      if (parts) {
        this.#leftBehind.add(id)
        if (recovered === 'finishing') this.#waiting.add(id)
      }
      if (recovered !== before) {
        log.info('meetings', 'Recovered a meeting left unfinished', { id, from: meta.status, to: recovered })
        if (meta.status === 'live' || meta.status === 'finishing') {
          meta.durationMs = Math.max(meta.durationMs, segments.at(-1)?.endMs ?? 0)
          meta.endedAt ??= meta.startedAt + meta.durationMs
          if (recovered === 'failed') meta.error ??= meta.audioOnly ? 'recording-failed' : 'helper-failed'
        }
        meta.status = recovered
      }
      // A transcript left half-rewritten by a crashed retranscribe is dropped; the original stays.
      rmSync(join(dir, 'transcript.next.jsonl'), { force: true })
      const entry: Entry = { meta, segments, live: {}, summary, progress: null, transcriptBytes }
      this.#entries.set(id, entry)
      if (recovered !== before) this.#writeMeta(entry)
    }
  }


  create(i: MeetingCreateInput): MeetingSummary {
    const id = randomUUID()
    const meta: Meta = {
      v: 1,
      id,
      kind: i.kind,
      title: i.title.trim().slice(0, MEETING_TITLE_MAX) || 'Untitled meeting',
      titleEdited: false,
      provider: i.provider ?? null,
      url: i.url ?? null,
      locale: i.locale,
      startedAt: i.startedAt,
      endedAt: null,
      durationMs: 0,
      status: 'live',
      recordAudio: i.recordAudio || Boolean(i.audioOnly),
      audioOnly: i.audioOnly ?? null,
      audioBytes: 0,
      labels: { mic: this.#opts.labels.you, system: this.#opts.labels.others },
      labelsEdited: { mic: false, system: false },
      error: null,
      warnings: [],
    }
    mkdirSync(join(this.root, id), { recursive: true })
    const entry: Entry = { meta, segments: [], live: {}, summary: null, progress: null, transcriptBytes: 0 }
    this.#entries.set(id, entry)
    this.#writeMeta(entry)
    this.#changed(id)
    return this.#summary(entry)
  }

  audioPathFor(id: string): string {
    if (!UUID.test(id)) throw new Error('Not a meeting id.')
    return join(this.root, id, 'audio.m4a')
  }

  appendSegment(id: string, s: Omit<TranscriptSegment, 'id'>): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    const text = s.text.trim()
    if (!text) return
    const segment: TranscriptSegment = { id: randomUUID(), source: s.source, text, startMs: s.startMs, endMs: s.endMs }
    const line = `${JSON.stringify(segment)}\n`
    appendFileSync(join(this.root, id, 'transcript.jsonl'), line, { mode: 0o600 })
    entry.transcriptBytes += Buffer.byteLength(line)
    entry.segments.push(segment)
    // The final replaces that source's partial.
    delete entry.live[s.source]
    entry.meta.durationMs = Math.max(entry.meta.durationMs, s.endMs)
    this.#search.delete(id)
    this.emit('live', { id, appended: [segment], live: { ...entry.live }, status: entry.meta.status })
    this.#changed(id)
  }

  setLive(id: string, live: Partial<Record<SpeechSource, string>>): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.live = { ...live }
    this.emit('live', { id, appended: [], live: { ...entry.live }, status: entry.meta.status })
  }

  warn(id: string, w: MeetingWarning): void {
    const entry = this.#entries.get(id)
    if (!entry || entry.meta.warnings.includes(w)) return
    entry.meta.warnings.push(w)
    this.#writeMeta(entry)
    this.#changed(id)
  }

  setAudioOnly(id: string, reason: AudioOnlyReason): void {
    const entry = this.#entries.get(id)
    if (!entry || entry.meta.audioOnly === reason) return
    entry.meta.audioOnly = reason
    entry.meta.recordAudio = true
    this.#writeMeta(entry)
    this.#changed(id)
  }

  finish(id: string, r: MeetingFinish): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    const meta = entry.meta
    meta.endedAt = r.endedAt
    meta.durationMs = Math.max(r.durationMs, entry.segments.at(-1)?.endMs ?? 0)
    meta.audioBytes = r.audio?.bytes ?? 0
    // Nothing heard at all is a failure the page can explain, not an empty meeting; an audio-only one without its audio is too.
    const empty = (r.status === 'transcribed' && entry.segments.length === 0) || (r.status === 'recorded' && meta.audioBytes === 0)
    meta.status = empty ? 'failed' : r.status
    meta.error = meta.status === 'failed' ? (r.error ?? (r.status === 'recorded' ? 'recording-failed' : entry.segments.length === 0 ? 'no-speech' : 'failed')) : null
    entry.live = {}
    this.#writeMeta(entry)
    this.emit('live', { id, appended: [], live: {}, status: meta.status })
    this.#changed(id)
    if (meta.status === 'transcribed') this.emit('finished', id)
  }

  /** Meetings with recording parts left to put back together (the library asks the helper at start-up). */
  recoverable(): string[] {
    return [...this.#leftBehind]
  }

  /**
   * The helper put a recording left in parts back together (`audio`), or
   * couldn't (null; the parts stay for the next start). A meeting that was
   * waiting for it settles: transcribed with its transcript, recorded when
   * audio only, failed otherwise; an audio-only one that failed for want of
   * its audio is recorded once it has it.
   */
  recovered(id: string, audio: { bytes: number; durationMs: number } | null): void {
    this.#leftBehind.delete(id)
    const waiting = this.#waiting.delete(id)
    const entry = this.#entries.get(id)
    if (!entry) return
    const meta = entry.meta
    if (audio && audio.bytes > 0) {
      meta.audioBytes = audio.bytes
      meta.recordAudio = true
      meta.durationMs = Math.max(meta.durationMs, Math.round(audio.durationMs))
    }
    const kept = meta.audioBytes > 0
    if (waiting) {
      meta.status = entry.segments.length > 0 ? 'transcribed' : meta.audioOnly && kept ? 'recorded' : 'failed'
      meta.error = meta.status === 'failed' ? (meta.audioOnly ? 'recording-failed' : 'helper-failed') : null
      meta.endedAt ??= meta.startedAt + meta.durationMs
    } else if (meta.status === 'failed' && meta.audioOnly && kept) {
      meta.status = 'recorded'
      meta.error = null
    }
    this.#writeMeta(entry)
    this.emit('live', { id, appended: [], live: {}, status: meta.status })
    this.#changed(id)
  }

  /** Marks a stopping recording; the recorder calls finish() once the audio is merged. */
  setFinishing(id: string): void {
    this.setStatus(id, 'finishing')
  }

  get(id: string): MeetingDetail | null {
    const entry = this.#entries.get(id)
    return entry ? this.#detail(entry) : null
  }

  // ── the library ──

  list(f: MeetingListFilter = {}): MeetingSummary[] {
    const words = queryWords(f.query)
    const out: MeetingSummary[] = []
    for (const entry of this.#entries.values()) {
      if (f.kind && entry.meta.kind !== f.kind) continue
      if (words.length > 0 && !matchesQuery(this.#searchText(entry), words)) continue
      out.push(this.#summary(entry))
    }
    // Live first, then newest.
    return out.sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live') || b.startedAt - a.startedAt)
  }

  has(id: string): boolean {
    return this.#entries.has(id)
  }

  status(id: string): MeetingStatus | null {
    return this.#entries.get(id)?.meta.status ?? null
  }

  setStatus(id: string, status: MeetingStatus, error: SpeechErrorCode | null = null): void {
    const entry = this.#entries.get(id)
    if (!entry || entry.meta.status === status) return
    entry.meta.status = status
    if (status === 'failed') entry.meta.error = error ?? entry.meta.error ?? 'failed'
    else entry.meta.error = null
    this.#writeMeta(entry)
    this.emit('live', { id, appended: [], live: { ...entry.live }, status })
    this.#changed(id)
  }

  setProgress(id: string, fraction: number | null): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.progress = fraction === null ? null : Math.max(0, Math.min(1, fraction))
    this.#changed(id)
  }

  rename(id: string, title: string): void {
    const entry = this.#require(id)
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, MEETING_TITLE_MAX)
    if (!clean) throw new Error('Give the meeting a name.')
    entry.meta.title = clean
    entry.meta.titleEdited = true
    this.#search.delete(id)
    this.#writeMeta(entry)
    this.#changed(id)
  }

  renameLabel(id: string, source: SpeechSource, label: string): void {
    const entry = this.#require(id)
    const clean = label.replace(/\s+/g, ' ').trim().slice(0, MEETING_LABEL_MAX)
    if (!clean) throw new Error('A label can’t be empty.')
    entry.meta.labels[source] = clean
    entry.meta.labelsEdited[source] = true
    this.#writeMeta(entry)
    this.#changed(id)
  }

  /** Saves a summary; its title and speaker names apply only where the person hasn't chosen their own. */
  setSummary(id: string, notes: MeetingNotes, labels?: Partial<Record<SpeechSource, string>>): void {
    const entry = this.#entries.get(id)
    if (!entry) return
    entry.summary = notes
    writeAtomic(join(this.root, id, 'summary.json'), JSON.stringify(notes, null, 2))
    if (!entry.meta.titleEdited && notes.title.trim()) entry.meta.title = notes.title.trim().slice(0, MEETING_TITLE_MAX)
    for (const source of ['mic', 'system'] as const) {
      const next = labels?.[source]?.trim()
      if (next && !entry.meta.labelsEdited[source]) entry.meta.labels[source] = next.slice(0, MEETING_LABEL_MAX)
    }
    entry.meta.status = 'summarized'
    entry.meta.error = null
    this.#search.delete(id)
    this.#writeMeta(entry)
    this.emit('live', { id, appended: [], live: {}, status: 'summarized' })
    this.#changed(id)
  }

  /** Replaces the transcript with one transcribed again from the audio (written aside first, then swapped). */
  replaceTranscript(id: string, segments: ReadonlyArray<Omit<TranscriptSegment, 'id'>>): void {
    const entry = this.#require(id)
    const kept = segments.filter((s) => s.text.trim()).map((s): TranscriptSegment => ({ id: randomUUID(), source: s.source, text: s.text.trim(), startMs: s.startMs, endMs: s.endMs }))
    const body = kept.map((s) => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : '')
    const dir = join(this.root, id)
    writeAtomic(join(dir, 'transcript.next.jsonl'), body)
    renameSync(join(dir, 'transcript.next.jsonl'), join(dir, 'transcript.jsonl'))
    entry.segments = kept
    entry.transcriptBytes = Buffer.byteLength(body)
    entry.meta.durationMs = Math.max(entry.meta.durationMs, kept.at(-1)?.endMs ?? 0)
    // Transcribed now: no longer audio only.
    entry.meta.audioOnly = null
    this.#search.delete(id)
  }

  /** Moves the meeting's folder to the Trash. A live meeting must be stopped first. */
  async remove(id: string): Promise<void> {
    const entry = this.#require(id)
    if (UNSETTLED.includes(entry.meta.status)) throw new Error('Stop the recording before deleting it.')
    this.#entries.delete(id)
    this.#search.delete(id)
    this.#changed(id)
    const dir = join(this.root, id)
    try {
      if (this.#opts.trash) await this.#opts.trash(dir)
      else rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      log.warn('meetings', 'Moving a meeting to the Trash failed; deleting it instead', { id, error: String(err) })
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Bytes on disk for every meeting (ST-53), and how many there are. */
  storage(): { bytes: number; count: number } {
    let bytes = 0
    for (const entry of this.#entries.values()) bytes += this.#size(entry)
    return { bytes, count: this.#entries.size }
  }

  #require(id: string): Entry {
    const entry = this.#entries.get(id)
    if (!entry) throw new Error('That meeting no longer exists.')
    return entry
  }

  #searchText(entry: Entry): string {
    let text = this.#search.get(entry.meta.id)
    if (text === undefined) {
      text = searchText(entry)
      this.#search.set(entry.meta.id, text)
    }
    return text
  }

  #size(entry: Entry): number {
    // meta.json and summary.json are a few KB at most; the audio and transcript dominate.
    return entry.meta.audioBytes + entry.transcriptBytes + 2048
  }

  #summary(entry: Entry): MeetingSummary {
    const m = entry.meta
    return {
      id: m.id,
      kind: m.kind,
      title: m.title,
      provider: m.provider,
      url: m.url,
      startedAt: m.startedAt,
      durationMs: m.status === 'live' ? Math.max(m.durationMs, (this.#opts.now?.() ?? Date.now()) - m.startedAt) : m.durationMs,
      status: m.status,
      hasAudio: m.audioBytes > 0,
      sizeBytes: this.#size(entry),
      snippet: snippetOf(entry),
      progress: entry.progress,
      labels: { ...m.labels },
      audioOnly: m.audioOnly,
    }
  }

  #detail(entry: Entry): MeetingDetail {
    const summary = this.#summary(entry)
    return {
      ...summary,
      segments: entry.segments.map((s) => ({ ...s })),
      live: { ...entry.live },
      labels: { ...entry.meta.labels },
      summary: entry.summary,
      audioUrl: summary.hasAudio ? `atelier-media://meeting/${entry.meta.id}/audio` : null,
      error: entry.meta.error,
      warnings: [...entry.meta.warnings],
    }
  }

  #writeMeta(entry: Entry): void {
    try {
      writeAtomic(join(this.root, entry.meta.id, 'meta.json'), JSON.stringify(entry.meta, null, 2))
    } catch (err) {
      log.error('meetings', 'Saving a meeting failed', { id: entry.meta.id, error: String(err) })
    }
  }

  #changed(id: string): void {
    this.emit('changed', id)
  }
}
