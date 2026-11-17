/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { EngineUnavailableError, type QuickModel } from '../src/main/agent/quick'
import { MeetingFileStore } from '../src/main/meetings/store'
import { chunkLines, FileMeetingSummarizer, groundNotes, meetingNotesSchema, readQueue, transcriptLines, type ModelNotes } from '../src/main/meetings/summarize'

// The after-meeting summary (ST-20, MV-12): the schema the model must meet,
// grounding (never invented participants), chunking of long transcripts and
// the persisted pending queue that waits for an engine.

let dataDir: string
let root: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'atelier-summary-'))
  root = join(dataDir, 'meetings')
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const NOTES: ModelNotes = {
  title: 'Launch plan',
  summary: 'Sam and you agreed on a May launch.',
  takeaways: ['Launch in May', 'Launch in May'],
  decisions: ['Use the new pricing page'],
  actionItems: [{ text: 'Draft the post', owner: 'Sam' }, { text: 'Book the room', owner: 'Alex' }],
  participants: ['Sam', 'Alex'],
  labels: { system: 'Sam', mic: 'Jordan' },
}

function newStore(): MeetingFileStore {
  const s = new MeetingFileStore(root, { labels: { you: 'You', others: 'Others' } })
  s.load()
  return s
}

function finishedMeeting(s: MeetingFileStore, lines = ['Hi, Sam here.', 'Shall we launch in May?']): string {
  const m = s.create({ kind: 'meeting', title: 'Weekly sync', locale: 'en-US', startedAt: 1000, recordAudio: false })
  lines.forEach((text, i) => s.appendSegment(m.id, { source: i % 2 ? 'mic' : 'system', text, startMs: i * 1000, endMs: i * 1000 + 900 }))
  s.finish(m.id, { endedAt: 9000, durationMs: lines.length * 1000, audio: null, status: 'transcribed' })
  return m.id
}

function fakeQuick(ready: boolean | (() => boolean), reply: (prompt: string) => unknown = () => NOTES): QuickModel & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ready: async () => ({ ok: typeof ready === 'function' ? ready() : ready, engine: null }),
    text: async () => '',
    structured: async () => '',
    stream: async () => '',
    toolLoop: async () => ({ text: '', history: [] }),
    json: async <T,>(r: { prompt: string; schema: z.ZodType<T> }) => {
      calls.push(r.prompt)
      return r.schema.parse(reply(r.prompt))
    },
  }
}

describe('meeting notes schema', () => {
  it('accepts the documented shape and rejects missing or wrong fields', () => {
    expect(meetingNotesSchema.safeParse(NOTES).success).toBe(true)
    expect(meetingNotesSchema.safeParse({ ...NOTES, title: '' }).success).toBe(false)
    expect(meetingNotesSchema.safeParse({ ...NOTES, actionItems: [{ owner: 'Sam' }] }).success).toBe(false)
    const { participants: _p, ...missing } = NOTES
    expect(meetingNotesSchema.safeParse(missing).success).toBe(false)
  })
})

describe('groundNotes', () => {
  it('keeps only participants, owners and labels that are spoken in the transcript', () => {
    const { notes, labels } = groundNotes(NOTES, '[0:00] Others: Hi, Sam here.', { mic: 'You', system: 'Others' })
    expect(notes.participants).toEqual(['Sam'])
    expect(notes.actionItems).toEqual([{ text: 'Draft the post', owner: 'Sam' }, { text: 'Book the room' }])
    expect(notes.takeaways).toEqual(['Launch in May'])
    expect(labels).toEqual({ system: 'Sam' })
  })
})

describe('chunking', () => {
  it('labels lines by source and splits long transcripts between lines', () => {
    const lines = transcriptLines({ segments: [{ id: 'a', source: 'mic', text: 'Hello', startMs: 65_000, endMs: 66_000 }], labels: { mic: 'Robin', system: 'Team' } })
    expect(lines).toEqual(['[1:05] Robin: Hello'])
    const chunks = chunkLines(['a'.repeat(6), 'b'.repeat(6), 'c'.repeat(20)], 14)
    expect(chunks).toEqual(['aaaaaa\nbbbbbb', 'c'.repeat(14)])
  })
})

describe('FileMeetingSummarizer', () => {
  it('summarises a finished meeting and stores grounded notes', async () => {
    const store = newStore()
    const id = finishedMeeting(store)
    const quick = fakeQuick(true)
    const summarizer = new FileMeetingSummarizer({ store, quick, queuePath: join(root, 'pending.json') })
    await summarizer.request(id)
    const d = store.get(id)
    expect(d?.status).toBe('summarized')
    expect(d?.summary?.participants).toEqual(['Sam'])
    expect(quick.calls).toHaveLength(1)
  })

  it('summarises long transcripts in parts and then merges them', async () => {
    const store = newStore()
    const id = finishedMeeting(store, Array.from({ length: 30 }, (_, i) => `Line ${i} ${'x'.repeat(3000)}`))
    const quick = fakeQuick(true)
    await new FileMeetingSummarizer({ store, quick, queuePath: join(root, 'pending.json') }).request(id)
    expect(quick.calls.length).toBeGreaterThan(2)
    expect(quick.calls.at(-1)).toContain('Merge them')
    expect(quick.calls[0]).toContain('part 1 of')
  })

  it('queues the meeting while no engine is ready, persists the queue and runs it once one is', async () => {
    const store = newStore()
    const id = finishedMeeting(store)
    let ready = false
    const quick = fakeQuick(() => ready)
    const queuePath = join(root, 'pending.json')
    const summarizer = new FileMeetingSummarizer({ store, quick, queuePath })
    await summarizer.request(id)
    expect(store.status(id)).toBe('summary-pending')
    expect(summarizer.pending()).toEqual([id])
    expect(readQueue(queuePath)).toEqual([{ id }])

    // A restart reads the queue back; flush does nothing until an engine is ready.
    const again = new FileMeetingSummarizer({ store, quick, queuePath })
    expect(again.pending()).toEqual([id])
    await again.flush()
    expect(quick.calls).toHaveLength(0)
    ready = true
    await again.flush()
    expect(store.status(id)).toBe('summarized')
    expect(again.pending()).toEqual([])
    expect(readQueue(queuePath)).toEqual([])
  })

  it('queues on EngineUnavailableError, and restores the status after any other failure', async () => {
    const store = newStore()
    const id = finishedMeeting(store)
    const unavailable = fakeQuick(true, () => {
      throw new EngineUnavailableError('signed out')
    })
    await new FileMeetingSummarizer({ store, quick: unavailable, queuePath: join(root, 'q1.json') }).request(id)
    expect(store.status(id)).toBe('summary-pending')

    const id2 = finishedMeeting(store)
    const broken = fakeQuick(true, () => ({ title: '' }))
    const s2 = new FileMeetingSummarizer({ store, quick: broken, queuePath: join(root, 'q2.json') })
    await expect(s2.request(id2)).rejects.toThrow()
    expect(store.status(id2)).toBe('transcribed')
    expect(s2.pending()).toEqual([])
  })

  it('joins a second request for the same meeting and refuses one still being transcribed', async () => {
    const store = newStore()
    const id = finishedMeeting(store)
    const quick = fakeQuick(true)
    const summarizer = new FileMeetingSummarizer({ store, quick, queuePath: join(root, 'pending.json') })
    const a = summarizer.request(id)
    expect(summarizer.request(id)).toBe(a)
    await a
    expect(quick.calls).toHaveLength(1)

    const live = store.create({ kind: 'recording', title: 'Memo', locale: 'en-US', startedAt: 1, recordAudio: false })
    await expect(summarizer.request(live.id)).rejects.toThrow(/still being transcribed/)
  })

  it('forgets a deleted meeting and reads a damaged queue as empty', () => {
    const store = newStore()
    const queuePath = join(root, 'pending.json')
    const summarizer = new FileMeetingSummarizer({ store, quick: fakeQuick(false), queuePath })
    summarizer.forget('nothing')
    expect(existsSync(queuePath)).toBe(false)
    expect(readQueue(join(root, 'missing.json'))).toEqual([])
    mkdirSync(root, { recursive: true })
    writeFileSync(queuePath, '{"v":1,"items":[{"id":7},{"id":"ok","companionId":3}]}')
    expect(readQueue(queuePath)).toEqual([{ id: 'ok' }])
    writeFileSync(queuePath, 'not json')
    expect(readQueue(queuePath)).toEqual([])
  })
})
