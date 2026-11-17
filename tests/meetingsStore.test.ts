/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingDetail } from '@shared/meetings'
import { MeetingFileStore, parseTranscript, queryWords, readMeta, recoveredStatus } from '../src/main/meetings/store'
import { meetingMarkdown, safeFileName } from '../src/main/meetings/export'
import { mediaResponse, mediaTarget, parseRange } from '../src/main/meetings/media'
import { createMeetingResolver, meetingPromptText } from '../src/main/meetings/resolver'

// The meetings library on disk, crash recovery, search, export, the
// atelier-media handler and the resolver chats use.

const LABELS = { you: 'You', others: 'Others' }
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const ID_C = '33333333-3333-4333-8333-333333333333'

let root: string
let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'atelier-meetings-'))
  root = join(dataDir, 'meetings')
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function store(trash?: (p: string) => Promise<void>): MeetingFileStore {
  const s = new MeetingFileStore(root, { labels: LABELS, trash })
  s.load()
  return s
}

function seedFolder(id: string, meta: Record<string, unknown>, transcript = ''): void {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'meta.json'), JSON.stringify({ id, kind: 'meeting', title: 'Seeded', startedAt: 1000, durationMs: 0, ...meta }))
  if (transcript) writeFileSync(join(root, id, 'transcript.jsonl'), transcript)
}

describe('MeetingFileStore', () => {
  it('creates a live meeting, appends finals to transcript.jsonl and finishes it', () => {
    const s = store()
    const live = vi.fn()
    const finished = vi.fn()
    s.on('live', live)
    s.on('finished', finished)
    const m = s.create({ kind: 'meeting', title: 'Weekly sync', locale: 'en-US', startedAt: 5000, recordAudio: false })
    expect(m.status).toBe('live')
    s.setLive(m.id, { mic: 'hel' })
    s.appendSegment(m.id, { source: 'mic', text: 'Hello everyone', startMs: 0, endMs: 1200 })
    s.appendSegment(m.id, { source: 'system', text: 'Hi, Sam here', startMs: 1300, endMs: 2500 })
    s.appendSegment(m.id, { source: 'mic', text: '   ', startMs: 2600, endMs: 2700 })
    expect(live).toHaveBeenCalledWith(expect.objectContaining({ id: m.id, appended: [expect.objectContaining({ text: 'Hello everyone' })], live: {} }))
    const lines = readFileSync(join(root, m.id, 'transcript.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    s.finish(m.id, { endedAt: 9000, durationMs: 2600, audio: null, status: 'transcribed' })
    const d = s.get(m.id) as MeetingDetail
    expect(d.status).toBe('transcribed')
    expect(d.segments.map((x) => x.text)).toEqual(['Hello everyone', 'Hi, Sam here'])
    expect(d.labels).toEqual({ mic: 'You', system: 'Others' })
    expect(d.audioUrl).toBeNull()
    expect(finished).toHaveBeenCalledWith(m.id)
  })

  it('treats a finished meeting with nothing heard as failed with no-speech', () => {
    const s = store()
    const m = s.create({ kind: 'recording', title: 'Memo', locale: 'en-US', startedAt: 1, recordAudio: false })
    s.finish(m.id, { endedAt: 2, durationMs: 1, audio: null, status: 'transcribed' })
    expect(s.get(m.id)?.status).toBe('failed')
    expect(s.get(m.id)?.error).toBe('no-speech')
  })

  it('keeps an audio-only meeting as recorded with its audio, and as a failure without it', () => {
    const s = store()
    const finished = vi.fn()
    s.on('finished', finished)
    const m = s.create({ kind: 'meeting', title: 'Standup', locale: 'nl-NL', startedAt: 1, recordAudio: false, audioOnly: 'chosen' })
    expect(s.get(m.id)?.audioOnly).toBe('chosen')
    s.finish(m.id, { endedAt: 2, durationMs: 60_000, audio: { path: s.audioPathFor(m.id), bytes: 4096 }, status: 'recorded' })
    expect(s.get(m.id)).toMatchObject({ status: 'recorded', audioOnly: 'chosen', hasAudio: true, error: null })
    // Nothing to summarise: the library's summary trigger stays quiet.
    expect(finished).not.toHaveBeenCalled()
    const lost = s.create({ kind: 'meeting', title: 'Lost', locale: 'en-US', startedAt: 3, recordAudio: false, audioOnly: 'speech-denied' })
    s.finish(lost.id, { endedAt: 4, durationMs: 1000, audio: null, status: 'recorded' })
    expect(s.get(lost.id)).toMatchObject({ status: 'failed', error: 'recording-failed' })
  })

  it('switches a meeting to audio only when transcription can’t start, and drops it once transcribed', () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'Sync', locale: 'xx-XX', startedAt: 1, recordAudio: false })
    s.setAudioOnly(m.id, 'locale-unsupported')
    expect(JSON.parse(readFileSync(join(root, m.id, 'meta.json'), 'utf8'))).toMatchObject({ audioOnly: 'locale-unsupported', recordAudio: true })
    s.finish(m.id, { endedAt: 2, durationMs: 5000, audio: { path: s.audioPathFor(m.id), bytes: 10 }, status: 'recorded' })
    s.replaceTranscript(m.id, [{ source: 'mic', text: 'Goedemorgen', startMs: 0, endMs: 900 }])
    s.setStatus(m.id, 'transcribed')
    expect(s.get(m.id)).toMatchObject({ status: 'transcribed', audioOnly: null })
  })

  it('rebuilds the index at start-up and recovers meetings left live (crash recovery)', () => {
    const seg = (text: string, endMs: number): string => `${JSON.stringify({ id: text, source: 'mic', text, startMs: endMs - 500, endMs })}\n`
    seedFolder(ID_A, { status: 'live' }, seg('first', 1000) + seg('second', 4000) + '{"id":"torn","sour')
    seedFolder(ID_B, { status: 'finishing' })
    seedFolder(ID_C, { status: 'summarizing' }, seg('done', 500))
    mkdirSync(join(root, 'not-a-meeting'))
    const s = new MeetingFileStore(root, { labels: LABELS })
    s.load([ID_C])
    expect(s.get(ID_A)?.status).toBe('transcribed')
    expect(s.get(ID_A)?.segments).toHaveLength(2)
    expect(s.get(ID_A)?.durationMs).toBe(4000)
    expect(s.get(ID_B)?.status).toBe('failed')
    expect(s.get(ID_B)?.error).toBe('helper-failed')
    expect(s.get(ID_C)?.status).toBe('summary-pending')
    // The recovered status is written back.
    expect(JSON.parse(readFileSync(join(root, ID_A, 'meta.json'), 'utf8')).status).toBe('transcribed')
    expect(s.list()).toHaveLength(3)
  })

  it('waits for a recording left in parts, then settles each kind of meeting once it is put back together', () => {
    const seg = `${JSON.stringify({ id: 's', source: 'mic', text: 'Hello', startMs: 0, endMs: 900 })}\n`
    const part = (id: string, name: string): void => writeFileSync(join(root, id, name), 'aac')
    // Audio only, crashed mid-meeting: its parts, and a half-written audio.m4a beside them.
    seedFolder(ID_A, { status: 'live', audioOnly: 'chosen', recordAudio: true })
    part(ID_A, '.audio.m4a.mic.0.part.aac')
    part(ID_A, '.audio.m4a.system.1500.part.aac')
    writeFileSync(join(root, ID_A, 'audio.m4a'), 'half')
    // Transcribed, crashed: the transcript stands, the audio follows.
    seedFolder(ID_B, { status: 'live', recordAudio: true }, seg)
    part(ID_B, '.audio.m4a.mic.0.part.aac')
    // Audio only, its merge failed at stop: failed until the parts are put together.
    seedFolder(ID_C, { status: 'failed', error: 'recording-failed', audioOnly: 'speech-denied' })
    part(ID_C, '.audio.m4a.mic.0.part.aac')
    const s = store()
    expect(s.recoverable().sort()).toEqual([ID_A, ID_B, ID_C].sort())
    expect(s.get(ID_A)).toMatchObject({ status: 'finishing', hasAudio: false })
    expect(s.get(ID_B)).toMatchObject({ status: 'transcribed', hasAudio: false })
    s.recovered(ID_A, { bytes: 4096, durationMs: 61_000 })
    expect(s.get(ID_A)).toMatchObject({ status: 'recorded', hasAudio: true, durationMs: 61_000, error: null })
    s.recovered(ID_B, { bytes: 2048, durationMs: 900 })
    expect(s.get(ID_B)).toMatchObject({ status: 'transcribed', hasAudio: true })
    s.recovered(ID_C, { bytes: 1024, durationMs: 5000 })
    expect(s.get(ID_C)).toMatchObject({ status: 'recorded', hasAudio: true, error: null })
    expect(s.recoverable()).toEqual([])
    expect(JSON.parse(readFileSync(join(root, ID_A, 'meta.json'), 'utf8')).status).toBe('recorded')
  })

  it('waits for the WAV parts Windows’ helper leaves behind, like the macOS ones', () => {
    // native/speech-win/Recorder.cs: `.audio.m4a.<source>.part.wav`, no start in the name (every part starts at 0).
    seedFolder(ID_A, { status: 'live', audioOnly: 'chosen', recordAudio: true })
    writeFileSync(join(root, ID_A, '.audio.m4a.mic.part.wav'), 'RIFF')
    writeFileSync(join(root, ID_A, '.audio.m4a.system.part.wav'), 'RIFF')
    const s = store()
    expect(s.recoverable()).toEqual([ID_A])
    expect(s.get(ID_A)).toMatchObject({ status: 'finishing', hasAudio: false })
    s.recovered(ID_A, { bytes: 37_568, durationMs: 3000 })
    expect(s.get(ID_A)).toMatchObject({ status: 'recorded', hasAudio: true, error: null })
  })

  it('fails a waiting recording its parts couldn’t rebuild, and tries again on the next start', () => {
    seedFolder(ID_A, { status: 'live', audioOnly: 'chosen' })
    writeFileSync(join(root, ID_A, '.audio.m4a.mic.0.part.aac'), 'aac')
    const s = store()
    s.recovered(ID_A, null)
    expect(s.get(ID_A)).toMatchObject({ status: 'failed', error: 'recording-failed' })
    // The parts are still there: the next start puts it back together after all.
    const next = store()
    expect(next.recoverable()).toEqual([ID_A])
    next.recovered(ID_A, { bytes: 10, durationMs: 1000 })
    expect(next.get(ID_A)?.status).toBe('recorded')
  })

  it('reads damaged files defensively', () => {
    expect(readMeta(null, ID_A, LABELS)).toBeNull()
    const meta = readMeta({ kind: 'nope', status: 'weird', labels: { mic: '' }, warnings: ['interrupted', 'bogus'] }, ID_A, LABELS)
    expect(meta).toMatchObject({ kind: 'meeting', status: 'failed', title: 'Untitled meeting', labels: { mic: 'You', system: 'Others' }, warnings: ['interrupted'] })
    expect(parseTranscript('{"source":"mic","text":"a","startMs":0,"endMs":1}\nnot json\n{"source":"x"}')).toHaveLength(1)
    expect(recoveredStatus('summarized', 0, false)).toBe('summarized')
    // Audio only: its audio is the meeting (a crash mid-transcribe goes back to it too).
    expect(recoveredStatus('live', 0, false, { only: true, kept: true })).toBe('recorded')
    expect(recoveredStatus('finishing', 0, false, { only: true, kept: true })).toBe('recorded')
    expect(recoveredStatus('live', 0, false, { only: true, kept: false })).toBe('failed')
    expect(readMeta({ audioOnly: 'nonsense' }, ID_A, LABELS)?.audioOnly).toBeNull()
    expect(readMeta({ audioOnly: 'speech-denied' }, ID_A, LABELS)?.audioOnly).toBe('speech-denied')
    expect(recoveredStatus('summarizing', 3, false)).toBe('transcribed')
  })

  it('searches titles, notes and transcripts, and filters by kind', () => {
    const s = store()
    const a = s.create({ kind: 'meeting', title: 'Budget review', locale: 'en-US', startedAt: 1, recordAudio: false })
    s.appendSegment(a.id, { source: 'system', text: 'The Q3 forecast looks fine', startMs: 0, endMs: 10 })
    const b = s.create({ kind: 'recording', title: 'Voice memo', locale: 'en-US', startedAt: 2, recordAudio: false })
    s.appendSegment(b.id, { source: 'mic', text: 'buy oat milk', startMs: 0, endMs: 10 })
    s.setSummary(b.id, { title: 'Groceries', summary: 'A shopping list', takeaways: [], decisions: [], actionItems: [{ text: 'Get bread' }], participants: [] })
    expect(s.list({ query: 'budget' }).map((m) => m.id)).toEqual([a.id])
    expect(s.list({ query: 'forecast q3' }).map((m) => m.id)).toEqual([a.id])
    expect(s.list({ query: 'bread' }).map((m) => m.id)).toEqual([b.id])
    expect(s.list({ kind: 'recording' }).map((m) => m.id)).toEqual([b.id])
    expect(s.list({ query: 'nothing here' })).toEqual([])
    expect(queryWords('  Two  words ')).toEqual(['two', 'words'])
  })

  it('keeps the person’s own title and labels over the summary’s suggestions', () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'Call', locale: 'en-US', startedAt: 1, recordAudio: false })
    s.appendSegment(m.id, { source: 'mic', text: 'hi', startMs: 0, endMs: 1 })
    s.finish(m.id, { endedAt: 2, durationMs: 1, audio: null, status: 'transcribed' })
    s.renameLabel(m.id, 'mic', '  Robin ')
    s.setSummary(m.id, { title: 'Planning call', summary: 's', takeaways: [], decisions: [], actionItems: [], participants: [] }, { mic: 'Alex', system: 'Sam' })
    let d = s.get(m.id) as MeetingDetail
    expect(d.title).toBe('Planning call')
    expect(d.labels).toEqual({ mic: 'Robin', system: 'Sam' })
    expect(d.status).toBe('summarized')
    s.rename(m.id, 'My title')
    s.setSummary(m.id, { title: 'Another', summary: 's', takeaways: [], decisions: [], actionItems: [], participants: [] })
    d = s.get(m.id) as MeetingDetail
    expect(d.title).toBe('My title')
    expect(() => s.rename(m.id, '   ')).toThrow()
    expect(() => s.renameLabel(m.id, 'system', '')).toThrow()
  })

  it('moves a deleted meeting to the Trash, and refuses while it is live', async () => {
    const trash = vi.fn(async (p: string) => rmSync(p, { recursive: true }))
    const s = store(trash)
    const live = s.create({ kind: 'meeting', title: 'Live', locale: 'en-US', startedAt: 1, recordAudio: false })
    await expect(s.remove(live.id)).rejects.toThrow(/Stop the recording/)
    s.appendSegment(live.id, { source: 'mic', text: 'x', startMs: 0, endMs: 1 })
    s.finish(live.id, { endedAt: 2, durationMs: 1, audio: null, status: 'transcribed' })
    await s.remove(live.id)
    expect(trash).toHaveBeenCalledWith(join(root, live.id))
    expect(s.get(live.id)).toBeNull()
    expect(existsSync(join(root, live.id))).toBe(false)
  })

  it('falls back to deleting when the Trash fails', async () => {
    const s = store(async () => {
      throw new Error('no trash')
    })
    const m = s.create({ kind: 'meeting', title: 'x', locale: 'en-US', startedAt: 1, recordAudio: false })
    s.finish(m.id, { endedAt: 2, durationMs: 1, audio: null, status: 'failed', error: 'failed' })
    await s.remove(m.id)
    expect(existsSync(join(root, m.id))).toBe(false)
  })

  it('replaces the transcript after transcribing again, and counts storage', () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'x', locale: 'en-US', startedAt: 1, recordAudio: true })
    writeFileSync(s.audioPathFor(m.id), Buffer.alloc(4096))
    s.finish(m.id, { endedAt: 2, durationMs: 1, audio: { path: s.audioPathFor(m.id), bytes: 4096 }, status: 'failed', error: 'helper-failed' })
    s.replaceTranscript(m.id, [{ source: 'system', text: 'again', startMs: 10, endMs: 900 }])
    const d = s.get(m.id) as MeetingDetail
    expect(d.segments.map((x) => x.text)).toEqual(['again'])
    expect(d.hasAudio).toBe(true)
    expect(d.audioUrl).toBe(`atelier-media://meeting/${m.id}/audio`)
    expect(s.storage().count).toBe(1)
    expect(s.storage().bytes).toBeGreaterThan(4096)
    expect(() => s.audioPathFor('../../etc')).toThrow()
  })
})

describe('meeting export', () => {
  const detail: MeetingDetail = {
    id: ID_A,
    kind: 'meeting',
    title: 'Plan: Q3/Q4',
    provider: null,
    url: null,
    startedAt: Date.UTC(2026, 9, 1, 9, 0),
    durationMs: 125_000,
    status: 'summarized',
    hasAudio: false,
    sizeBytes: 0,
    snippet: '',
    segments: [
      { id: '1', source: 'mic', text: 'Shall we start?', startMs: 0, endMs: 1000 },
      { id: '2', source: 'system', text: 'Yes, go ahead.', startMs: 65_000, endMs: 66_000 },
    ],
    live: {},
    labels: { mic: 'Robin', system: 'Team' },
    summary: { title: 'Plan', summary: 'We agreed the plan.', takeaways: ['Ship in May'], decisions: ['Use the new API'], actionItems: [{ text: 'Write the doc', owner: 'Robin' }], participants: ['Robin'] },
    audioUrl: null,
    error: null,
    warnings: [],
  }

  it('writes the notes and the labelled transcript as Markdown', () => {
    const md = meetingMarkdown(detail, 'en-GB')
    expect(md).toMatch(/^# Plan: Q3\/Q4\n/)
    expect(md).toContain('2 minutes')
    expect(md).toContain('**Participants:** Robin')
    expect(md).toContain('## Takeaways\n\n- Ship in May')
    expect(md).toContain('- [ ] Write the doc (Robin)')
    expect(md).toContain('**Robin** [0:00]: Shall we start?')
    expect(md).toContain('**Team** [1:05]: Yes, go ahead.')
  })

  it('makes safe file names', () => {
    expect(safeFileName('Plan: Q3/Q4', 'md')).toBe('Plan Q3 Q4.md')
    expect(safeFileName('  ', 'm4a')).toBe('Meeting.m4a')
  })
})

describe('atelier-media', () => {
  it('serves only meeting audio and the mic test, confined to their folders', () => {
    expect(mediaTarget(`atelier-media://meeting/${ID_A}/audio`, dataDir)).toBe(join(dataDir, 'meetings', ID_A, 'audio.m4a'))
    expect(mediaTarget('atelier-media://speech/test', dataDir)).toBe(join(dataDir, 'speech', 'test.m4a'))
    expect(mediaTarget('atelier-media://meeting/../../secrets/audio', dataDir)).toBeNull()
    expect(mediaTarget(`atelier-media://meeting/${ID_A}/transcript`, dataDir)).toBeNull()
    expect(mediaTarget('atelier-media://meeting/not-a-uuid/audio', dataDir)).toBeNull()
    expect(mediaTarget(`atelier-media://meeting/${ID_A}/audio?x=1`, dataDir)).toBeNull()
    expect(mediaTarget('atelier-media://other/test', dataDir)).toBeNull()
    expect(mediaTarget('https://example.com/a', dataDir)).toBeNull()
  })

  it('parses single byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
    expect(parseRange('items=0-1', 100)).toBeNull()
  })

  it('answers a Range request with 206 and the slice', async () => {
    mkdirSync(join(dataDir, 'meetings', ID_A), { recursive: true })
    writeFileSync(join(dataDir, 'meetings', ID_A, 'audio.m4a'), Buffer.from('0123456789'))
    const url = `atelier-media://meeting/${ID_A}/audio`
    const partial = mediaResponse(url, 'bytes=2-5', dataDir)
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await partial.text()).toBe('2345')
    const whole = mediaResponse(url, null, dataDir)
    expect(whole.status).toBe(200)
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(await whole.text()).toBe('0123456789')
    expect(mediaResponse(url, 'bytes=20-', dataDir).status).toBe(416)
    expect(mediaResponse(`atelier-media://meeting/${ID_B}/audio`, null, dataDir).status).toBe(404)
  })
})

describe('MeetingResolver', () => {
  it('is not ready while the transcript is still being finished, and then gives the notes and labelled transcript', async () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'Design "review"', locale: 'en-US', startedAt: 0, recordAudio: false })
    s.appendSegment(m.id, { source: 'mic', text: 'Looks good', startMs: 0, endMs: 1000 })
    const resolver = createMeetingResolver(s)
    expect((await resolver.forPrompt(m.id)).ready).toBe(false)
    s.finish(m.id, { endedAt: 1, durationMs: 1000, audio: null, status: 'transcribed' })
    const r = await resolver.forPrompt(m.id)
    expect(r.ready).toBe(true)
    expect(r.title).toBe('Design "review"')
    expect(r.text).toMatch(/^<meeting title="Design &quot;review&quot;"/)
    expect(r.text).toContain('[0:00] You: Looks good')
    expect(r.text).toContain('"You" is the person\'s own microphone')
    expect(r.text.trim().endsWith('</meeting>')).toBe(true)
    await expect(resolver.forPrompt(ID_B)).rejects.toThrow(/no longer exists/)
  })

  it('tells the companion an audio-only meeting has no transcript', () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'Kickoff', locale: 'en-US', startedAt: 1, recordAudio: true, audioOnly: 'chosen' })
    s.finish(m.id, { endedAt: 2, durationMs: 120_000, audio: { path: s.audioPathFor(m.id), bytes: 10 }, status: 'recorded' })
    const text = meetingPromptText(s.get(m.id) as MeetingDetail)
    expect(text).toContain('recorded as audio only')
    expect(text).not.toContain('Transcript, labelled')
  })

  it('cuts the middle of a very long transcript', () => {
    const s = store()
    const m = s.create({ kind: 'meeting', title: 'Long', locale: 'en-US', startedAt: 0, recordAudio: false })
    for (let i = 0; i < 200; i++) s.appendSegment(m.id, { source: 'system', text: `line ${i} ${'x'.repeat(40)}`, startMs: i * 1000, endMs: i * 1000 + 900 })
    const text = meetingPromptText(s.get(m.id) as MeetingDetail, 2000)
    expect(text).toContain('left out')
    expect(text).toContain('line 0 ')
    expect(text).toContain('line 199 ')
    expect(text.length).toBeLessThan(3000)
  })
})
