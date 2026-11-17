/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { MeetingDetail, MeetingNotes, MeetingSummarizer } from '@shared/meetings'
import type { SpeechSource } from '@shared/speech'
import { EngineUnavailableError, type QuickModel } from '../agent/quick'
import { log } from '../log'
import { writeAtomic } from '../settings'
import type { MeetingFileStore } from './store'

// The after-meeting summary (ST-20, MV-12): one QuickModel call on the
// person's own engine with an Atelier-written prompt. Long transcripts are cut
// into chunks, summarised one by one and then merged. With no engine ready
// the meeting waits in a persisted queue and is summarised once one is.

/** Characters of transcript per call; long meetings are summarised in parts, then merged. */
export const CHUNK_CHARS = 48_000

const line = z.string().trim().min(1).max(600)

/** What the model must return; anything else is retried once by QuickModel.json, then fails. */
export const meetingNotesSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(4000),
  takeaways: z.array(line).max(12),
  decisions: z.array(line).max(12),
  actionItems: z.array(z.object({ text: line, owner: z.string().trim().max(80).optional() })).max(20),
  participants: z.array(z.string().trim().min(1).max(80)).max(30),
  labels: z.object({ mic: z.string().trim().max(40).optional(), system: z.string().trim().max(40).optional() }).optional(),
})

export type ModelNotes = z.infer<typeof meetingNotesSchema>

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** The transcript as timestamped lines, labelled by audio source (the helper can't tell voices apart). */
export function transcriptLines(detail: Pick<MeetingDetail, 'segments' | 'labels'>): string[] {
  return detail.segments.map((s) => `[${clock(s.startMs)}] ${detail.labels[s.source]}: ${s.text}`)
}

/** Splits lines into chunks of at most `max` characters, never inside a line (an overlong line is cut). */
export function chunkLines(lines: readonly string[], max = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  for (const raw of lines) {
    const l = raw.length > max ? raw.slice(0, max) : raw
    if (current && current.length + 1 + l.length > max) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current}\n${l}` : l
  }
  if (current) chunks.push(current)
  return chunks
}

// Atelier's own prompt, in the companion's voice: warm, plain and short.
export const SUMMARY_SYSTEM = [
  `You are the person’s companion in the ${BRAND_NAME} browser, writing notes about a meeting or recording they just had.`,
  'Write the way a thoughtful friend would jot them down for them: warm, plain and brief, in the language the transcript is in (when it mixes two, the one most of it is in; quote the other language as it was said).',
  'The transcript is labelled by audio source, not by person: the first label is the person’s own microphone, the second is everyone else on the call.',
  'Rules:',
  '- Only use what the transcript says. Never invent names, numbers, decisions or tasks.',
  '- participants: only names that are actually spoken in the transcript. If none are, return an empty list.',
  '- labels: suggest a name for "mic" or "system" only when the transcript makes it clear who that is (for example someone introduces themself); otherwise leave it out.',
  '- actionItems: concrete next steps; give an owner only when the transcript names one.',
  '- title: a short, specific title of at most eight words.',
  'Reply with JSON only, no prose and no code fence, in this shape:',
  '{"title": string, "summary": string, "takeaways": string[], "decisions": string[], "actionItems": [{"text": string, "owner"?: string}], "participants": string[], "labels"?: {"mic"?: string, "system"?: string}}',
].join('\n')

export function chunkPrompt(title: string, chunk: string, part: number, parts: number): string {
  const where = parts > 1 ? `This is part ${part} of ${parts} of the transcript. Summarise only this part.\n\n` : ''
  return `Meeting: ${title}\n\n${where}Transcript:\n${chunk}`
}

export function mergePrompt(title: string, partials: readonly ModelNotes[]): string {
  return `Meeting: ${title}\n\nThese are notes on consecutive parts of one long meeting, in order. Merge them into one set of notes for the whole meeting, keeping only what matters and removing repeats.\n\n${JSON.stringify(partials)}`
}

/**
 * Drops anything the transcript doesn't support: participants, owners and
 * speaker names must be spoken in it. The model is told this; this is the guard.
 */
export function groundNotes(notes: ModelNotes, transcript: string, labels: { mic: string; system: string }): { notes: MeetingNotes; labels: Partial<Record<SpeechSource, string>> } {
  const haystack = transcript.toLowerCase()
  const spoken = (name: string | undefined): boolean => !!name && haystack.includes(name.toLowerCase())
  const known = (name: string | undefined): boolean => spoken(name) || name === labels.mic || name === labels.system
  const uniq = (list: string[]): string[] => [...new Set(list)]
  const suggested: Partial<Record<SpeechSource, string>> = {}
  if (notes.labels?.mic && spoken(notes.labels.mic)) suggested.mic = notes.labels.mic
  if (notes.labels?.system && spoken(notes.labels.system)) suggested.system = notes.labels.system
  return {
    notes: {
      title: notes.title,
      summary: notes.summary,
      takeaways: uniq(notes.takeaways),
      decisions: uniq(notes.decisions),
      actionItems: notes.actionItems.map((a) => (a.owner && known(a.owner) ? { text: a.text, owner: a.owner } : { text: a.text })),
      participants: uniq(notes.participants.filter((p) => spoken(p))),
    },
    labels: suggested,
  }
}

export interface SummarizerDeps {
  store: MeetingFileStore
  quick: QuickModel
  /** Where the pending queue is kept: userData/meetings/pending.json. */
  queuePath: string
}

interface Pending {
  id: string
  companionId?: string
}

export class FileMeetingSummarizer implements MeetingSummarizer {
  readonly #deps: SummarizerDeps
  #queue: Pending[]
  readonly #running = new Map<string, Promise<void>>()
  #flushing: Promise<void> | null = null

  constructor(deps: SummarizerDeps) {
    this.#deps = deps
    this.#queue = readQueue(deps.queuePath)
  }

  pending(): string[] {
    return this.#queue.map((p) => p.id)
  }

  /**
   * Summarises a meeting now, or queues it when no engine is ready (the
   * meeting shows "summary pending"). A second request for the same meeting
   * joins the first. Rejects with the failure for anything but a missing engine.
   */
  request(id: string, o: { companionId?: string } = {}): Promise<void> {
    const running = this.#running.get(id)
    if (running) return running
    const run = this.#run(id, o).finally(() => this.#running.delete(id))
    this.#running.set(id, run)
    return run
  }

  /** Runs the queue once an engine is ready; called at start-up, on settings changes and on a slow timer. */
  flush(): Promise<void> {
    if (this.#queue.length === 0) return Promise.resolve()
    this.#flushing ??= (async () => {
      try {
        const ready = await this.#deps.quick.ready().catch(() => ({ ok: false }))
        if (!ready.ok) return
        for (const item of [...this.#queue]) {
          await this.request(item.id, { companionId: item.companionId }).catch((err: unknown) => log.warn('meetings', 'A queued summary failed', { id: item.id, error: String(err) }))
        }
      } finally {
        this.#flushing = null
      }
    })()
    return this.#flushing
  }

  /** Forgets a deleted meeting. */
  forget(id: string): void {
    if (!this.#queue.some((p) => p.id === id)) return
    this.#queue = this.#queue.filter((p) => p.id !== id)
    this.#save()
  }

  async #run(id: string, o: { companionId?: string }): Promise<void> {
    const { store, quick } = this.#deps
    const detail = store.get(id)
    if (!detail) {
      this.forget(id)
      throw new Error('That meeting no longer exists.')
    }
    if (detail.status === 'live' || detail.status === 'finishing') throw new Error('The meeting is still being transcribed. Try again when it has finished.')
    if (detail.segments.length === 0) {
      this.forget(id)
      throw new Error('There is no transcript to summarise.')
    }
    const before = detail.status
    const ready = await quick.ready().catch(() => ({ ok: false }))
    if (!ready.ok) {
      this.#enqueue({ id, companionId: o.companionId })
      store.setStatus(id, 'summary-pending')
      return
    }
    store.setStatus(id, 'summarizing')
    try {
      const lines = transcriptLines(detail)
      const chunks = chunkLines(lines)
      const partials: ModelNotes[] = []
      for (const [i, chunk] of chunks.entries()) {
        partials.push(await quick.json({ system: SUMMARY_SYSTEM, prompt: chunkPrompt(detail.title, chunk, i + 1, chunks.length), schema: meetingNotesSchema, maxTokens: 2048 }))
      }
      const merged = partials.length === 1 && partials[0] ? partials[0] : await quick.json({ system: SUMMARY_SYSTEM, prompt: mergePrompt(detail.title, partials), schema: meetingNotesSchema, maxTokens: 2048 })
      const grounded = groundNotes(merged, lines.join('\n'), detail.labels)
      if (!store.has(id)) return
      store.setSummary(id, grounded.notes, grounded.labels)
      this.forget(id)
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        this.#enqueue({ id, companionId: o.companionId })
        store.setStatus(id, 'summary-pending')
        return
      }
      // A summary that failed leaves the transcript as it was; Summarise tries again.
      store.setStatus(id, before === 'summarized' ? 'summarized' : 'transcribed')
      this.forget(id)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  #enqueue(p: Pending): void {
    if (this.#queue.some((q) => q.id === p.id)) return
    this.#queue.push(p)
    this.#save()
  }

  #save(): void {
    try {
      writeAtomic(this.#deps.queuePath, JSON.stringify({ v: 1, items: this.#queue }))
    } catch (err) {
      log.warn('meetings', 'Saving the summary queue failed', { error: String(err) })
    }
  }
}

export function readQueue(path: string): Pending[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { items?: unknown }
    if (!Array.isArray(raw.items)) return []
    return raw.items.flatMap((p): Pending[] => {
      if (!p || typeof p !== 'object' || typeof (p as Pending).id !== 'string') return []
      const companionId = (p as Pending).companionId
      return [{ id: (p as Pending).id, ...(typeof companionId === 'string' ? { companionId } : {}) }]
    })
  } catch {
    return []
  }
}
