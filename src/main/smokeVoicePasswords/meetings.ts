/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UI } from '@shared/ipc'
import type { MeetingDetail, MeetingKind, MeetingNotes, TranscriptSegment } from '@shared/meetings'
import type { SpeechStatus } from '@shared/speech'
import { chatUrl } from '@shared/url'
import { meetingsLibrary, smokeMeetings } from '../meetings'
import { captureSmokeHooks } from '../meetings/capture'
import { fakeM4a } from '../speech/fakeAudio'
import { assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// The meetings library over seeded meetings (list, search,
// detail, a renamed speaker label), Markdown export to a temp folder, a
// meeting attached to a chat reaching the offline client, MV-14's held send,
// ST-20's auto-summary, and composer dictation over the fake helper (the
// words "heard" arrive as the speech-session event the helper would cause).
// Offline only. Seeded meetings stay in the smoke run's temporary userData:
// deleting would move them to the real Trash.

const STANDUP = 'Smoke standup'
const MEMO = 'Smoke voice memo'
const PLANNING = 'Smoke planning'

const STANDUP_LINES: Array<Omit<TranscriptSegment, 'id'>> = [
  { source: 'mic', text: 'Shall we ship the beta on Friday?', startMs: 0, endMs: 2400 },
  { source: 'system', text: 'Friday works if the installer is signed by Thursday.', startMs: 2600, endMs: 6200 },
  { source: 'mic', text: 'Great, then I will write the release notes.', startMs: 6400, endMs: 9000 },
]

const STANDUP_NOTES: MeetingNotes = {
  title: STANDUP,
  summary: 'The beta ships on Friday once the installer is signed.',
  takeaways: ['Signing the installer is the last blocker.'],
  decisions: ['Ship the beta on Friday'],
  actionItems: [{ text: 'Write the release notes', owner: 'You' }],
  participants: [],
}

/** The chat page in the visible tab (hidden tabs keep theirs mounted). */
const CHAT = `[...document.querySelectorAll('.chat-view--page')].find((e) => e.getClientRects().length > 0)`

function library(): NonNullable<ReturnType<typeof meetingsLibrary>> {
  const lib = meetingsLibrary()
  assert(lib, 'the meetings library is running')
  return lib
}

/** Runs `body` with auto-summarize set to `on`, then puts the setting back. */
async function withAutoSummarize<T>(ctx: SmokeContext, on: boolean, body: () => Promise<T> | T): Promise<T> {
  const before = ctx.settings.get().transcription.autoSummarize
  ctx.settings.update({ transcription: { autoSummarize: on } })
  try {
    return await body()
  } finally {
    ctx.settings.update({ transcription: { autoSummarize: before } })
  }
}

interface SeedSpec {
  title: string
  kind: MeetingKind
  lines: ReadonlyArray<Omit<TranscriptSegment, 'id'>>
  notes?: MeetingNotes
  /** Leave it live (still being transcribed). */
  live?: boolean
  startedAt?: number
}

/** Creates a meeting the way the recorder would; returns its id. Never summarised automatically. */
async function seed(ctx: SmokeContext, spec: SeedSpec): Promise<string> {
  const { store } = library()
  return withAutoSummarize(ctx, false, () => {
    const startedAt = spec.startedAt ?? Date.now() - 3_600_000
    const { id } = store.create({ kind: spec.kind, title: spec.title, locale: 'en-US', startedAt, recordAudio: false })
    for (const line of spec.lines) store.appendSegment(id, line)
    if (!spec.live) {
      const durationMs = Math.max(65_000, spec.lines.at(-1)?.endMs ?? 0)
      store.finish(id, { endedAt: startedAt + durationMs, durationMs, audio: null, status: 'transcribed' })
      if (spec.notes) store.setSummary(id, spec.notes)
    }
    return id
  })
}

/** The seeded standup and voice memo, created once per run (the shots reuse them). */
async function seeded(ctx: SmokeContext): Promise<{ standup: string; memo: string }> {
  const { store } = library()
  const find = (title: string): string | undefined => store.list({}).find((m) => m.title === title)?.id
  const standup = find(STANDUP) ?? (await seed(ctx, { title: STANDUP, kind: 'meeting', lines: STANDUP_LINES, notes: STANDUP_NOTES }))
  const memo =
    find(MEMO) ??
    (await seed(ctx, { title: MEMO, kind: 'recording', lines: [{ source: 'mic', text: 'Remember to book the venue for the offsite.', startMs: 0, endMs: 3000 }], startedAt: Date.now() - 7_200_000 }))
  return { standup, memo }
}

const AUDIO_ONLY = 'Smoke audio only'

/** A meeting recorded as audio only because Speech Recognition was off, with real audio; created once per run. */
function seededAudioOnly(): string {
  const { store } = library()
  const found = store.list({}).find((m) => m.title === AUDIO_ONLY)?.id
  if (found) return found
  const startedAt = Date.now() - 1_800_000
  const { id } = store.create({ kind: 'meeting', title: AUDIO_ONLY, locale: 'en-US', startedAt, recordAudio: true, audioOnly: 'speech-denied' })
  const audio = fakeM4a()
  writeFileSync(store.audioPathFor(id), audio)
  store.finish(id, { endedAt: startedAt + 1000, durationMs: 1000, audio: { path: store.audioPathFor(id), bytes: audio.length }, status: 'recorded' })
  return id
}

const titles = `[...document.querySelectorAll('.mt-row__title')].map((e) => e.textContent)`

async function rowsInclude(ctx: SmokeContext, title: string, what: string): Promise<void> {
  await ctx.chrome.until(`return ${titles}.includes(${JSON.stringify(title)})`, 8000, what)
}

/** Types into the visible chat page's composer the way a user would. */
async function typeInChat(ctx: SmokeContext, text: string): Promise<void> {
  const ok = await ctx.chrome.js<boolean>(`
    const el = ${CHAT}?.querySelector('.chat-composer__field')
    if (!el) return false
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true`)
  assert(ok, 'the chat page has a composer')
}

/** Clicks an enabled element inside the visible chat page once it shows. */
async function clickInChat(ctx: SmokeContext, selector: string, what: string): Promise<void> {
  await ctx.chrome.until(
    `const el = ${CHAT}?.querySelector(${JSON.stringify(selector)})
     if (!el || el.disabled) return false
     el.click()
     return true`,
    8000,
    what,
  )
}

const fieldValue = (ctx: SmokeContext): Promise<string | null> => ctx.chrome.js<string | null>(`return ${CHAT}?.querySelector('.chat-composer__field')?.value ?? null`)

async function openAsk(ctx: SmokeContext, id: string): Promise<void> {
  ctx.tabs.openInternal(`apex://meetings/${id}`)
  await ctx.chrome.until(`return document.querySelector('.mt-head__title')`, 8000, 'the meeting page')
  await ctx.chrome.click(/^Ask about this meeting$/, `document.querySelector('.mt-head__actions')`, 8000)
  // The composer's chips are the shared ones; the meeting is a .cmp-chip.
  await ctx.chrome.until(`return ${CHAT}?.querySelector('.cmp-chips .cmp-chip')`, 8000, 'the new chat with the meeting chip')
}

const library_: SmokeCheck = {
  name: 'meetings: the library lists, filters and searches seeded meetings, and a meeting page shows notes and a renamed label',
  async run(ctx) {
    const { standup, memo } = await seeded(ctx)
    ctx.tabs.openInternal('apex://meetings')
    await rowsInclude(ctx, STANDUP, 'the seeded meeting in the list')
    assert(!(await ctx.chrome.js<string[]>(`return ${titles}`)).includes(MEMO), 'recordings stay out of the Meetings list')

    await ctx.chrome.click(/^Recordings$/, `document.querySelector('.mt-toolbar')`)
    await rowsInclude(ctx, MEMO, 'the voice memo under Recordings')
    await ctx.chrome.click(/^Meetings$/, `document.querySelector('.mt-toolbar')`)
    await rowsInclude(ctx, STANDUP, 'back on Meetings')

    // Search reaches into the transcript, not just titles.
    await ctx.chrome.type('.mt-toolbar input[type="search"]', 'installer is signed')
    await ctx.chrome.until(`const t = ${titles}; return t.length === 1 && t[0] === ${JSON.stringify(STANDUP)}`, 8000, 'a transcript match')
    await ctx.chrome.type('.mt-toolbar input[type="search"]', 'zz no such words zz')
    await ctx.chrome.until(`return document.body.innerText.includes('Nothing matches')`, 8000, 'the no-results state')
    await ctx.chrome.type('.mt-toolbar input[type="search"]', '')

    ctx.tabs.openInternal(`apex://meetings/${standup}`)
    await ctx.chrome.until(`return document.querySelector('.mt-notes__summary')?.textContent.includes('installer is signed')`, 8000, 'the summary card')
    await ctx.chrome.until(`return [...document.querySelectorAll('.mt-run__label')].map((e) => e.textContent).join('|') === 'You|Others|You'`, 8000, 'transcript runs labelled You and Others')
    await ctx.chrome.invoke('meetings', 'renameLabel', standup, 'system', 'Design team')
    await ctx.chrome.until(`return [...document.querySelectorAll('.mt-run__label')].some((e) => e.textContent === 'Design team')`, 8000, 'the renamed label in the transcript')
    const detail = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', standup)
    assert(detail.labels.system === 'Design team' && detail.labels.mic === 'You', 'the label rename is kept per meeting')
    const other = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', memo)
    assert(other.labels.system !== 'Design team', 'another meeting keeps its own labels')
  },
}

const exportMarkdown: SmokeCheck = {
  name: 'meetings: Markdown export writes the notes and the labelled transcript',
  async run(ctx) {
    const { standup } = await seeded(ctx)
    const target = join(mkdtempSync(join(tmpdir(), 'apex-smoke-meetings-')), 'standup.md')
    smokeMeetings.queueSave(target)
    const path = await ctx.chrome.invoke<string | null>('meetings', 'exportFile', standup, 'markdown')
    assert(path === target, `exported to the chosen path (${String(path)})`)
    const md = readFileSync(target, 'utf8')
    const labels = (await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', standup)).labels
    for (const part of [`# ${STANDUP}`, '## Decisions', '- Ship the beta on Friday', '- [ ] Write the release notes (You)', `**${labels.system}** [0:02]: Friday works`]) {
      assert(md.includes(part), `the export has "${part}"`)
    }
  },
}

const attach: SmokeCheck = {
  name: 'meetings: Ask about this meeting attaches it, and the request carries its notes and transcript',
  async run(ctx) {
    const { standup } = await seeded(ctx)
    await openAsk(ctx, standup)
    const before = ctx.client.requests
    await typeInChat(ctx, 'What did we decide?')
    await clickInChat(ctx, '.chat-primary--send', 'the send button')
    await waitFor(() => ctx.client.requests > before, 15000, 'the offline client to answer')
    const text = ctx.client.lastText
    assert(text.includes(`<meeting title="${STANDUP}"`), 'the request has the meeting block')
    assert(text.includes('Decisions:\n- Ship the beta on Friday'), 'the block has the notes')
    assert(text.includes('Friday works if the installer is signed by Thursday.'), 'the block has the transcript')
    assert(text.includes('What did we decide?'), 'the typed words go with it')
    await ctx.chrome.until(`return ${CHAT}?.querySelector('.chat-sent-attach .chat-attach__name')?.textContent === ${JSON.stringify(STANDUP)}`, 8000, 'the sent meeting chip in the chat log')
  },
}

const holdAndSend: SmokeCheck = {
  name: 'meetings: a message with an unfinished meeting waits, can be cancelled, and goes out once transcribed (MV-14)',
  async run(ctx) {
    const { store } = library()
    const id = await seed(ctx, { title: PLANNING, kind: 'meeting', live: true, startedAt: Date.now() - 60_000, lines: [{ source: 'mic', text: 'Let us plan the offsite agenda.', startMs: 0, endMs: 2000 }] })
    try {
      await openAsk(ctx, id)
      await ctx.chrome.until(`return ${CHAT}?.querySelector('.cmp-chips .cmp-chip--preparing')`, 8000, 'the chip to say it is still transcribing')
      const before = ctx.client.requests
      const message = 'Draft the agenda from this.'
      await typeInChat(ctx, message)
      await clickInChat(ctx, '.chat-primary--send', 'the send button')
      await ctx.chrome.until(`return ${CHAT}?.querySelector('.cmp-chips__held') && ${CHAT}?.querySelector('.cmp-chips .cmp-chip__name')?.textContent === ${JSON.stringify(PLANNING)}`, 8000, 'the waiting chip')
      await ctx.chrome.until(`return ${CHAT}?.querySelector('.chat-primary--busy')`, 5000, 'the primary to show a disabled spinner while waiting')
      await sleep(400)
      assert(ctx.client.requests === before, 'nothing is sent while the meeting is live')

      // Cancel puts the words and the chip back.
      await ctx.chrome.click(/^Cancel/, `${CHAT}?.querySelector('.cmp-chips__held')`)
      await ctx.chrome.until(`return !${CHAT}?.querySelector('.cmp-chips__held') && ${CHAT}?.querySelector('.cmp-chips .cmp-chip--preparing')`, 8000, 'the chip back after cancelling')
      assert((await fieldValue(ctx)) === message, 'the message is back in the composer')

      await clickInChat(ctx, '.chat-primary--send', 'the send button again')
      await ctx.chrome.until(`return ${CHAT}?.querySelector('.cmp-chips__held')`, 8000, 'the waiting chip again')
      store.appendSegment(id, { source: 'system', text: 'Morning workshops, afternoon off.', startMs: 2200, endMs: 4200 })
      await withAutoSummarize(ctx, false, () => store.finish(id, { endedAt: Date.now(), durationMs: 60_000, audio: null, status: 'transcribed' }))
      await waitFor(() => ctx.client.requests > before, 15000, 'the held message to go out')
      const text = ctx.client.lastText
      assert(text.includes('Morning workshops, afternoon off.'), 'the request has the finished transcript')
      assert(text.includes(message), 'the held words go out')
      await ctx.chrome.until(`return !${CHAT}?.querySelector('.cmp-chips__held') && ${CHAT}?.querySelector('.chat-sent-attach')`, 8000, 'the waiting chip to clear')
    } finally {
      if (store.status(id) === 'live') store.finish(id, { endedAt: Date.now(), durationMs: 60_000, audio: null, status: 'transcribed' })
    }
  },
}

const autoSummary: SmokeCheck = {
  name: 'meetings: with auto-summarize on a finished meeting is summarised; off, it waits for Summarize (ST-20)',
  async run(ctx) {
    const { store } = library()
    const lines = [{ source: 'mic' as const, text: 'A quick note about the quarterly numbers.', startMs: 0, endMs: 2500 }]
    const finish = (id: string): void => store.finish(id, { endedAt: Date.now(), durationMs: 65_000, audio: null, status: 'transcribed' })
    const status = async (id: string): Promise<string> => (await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', id)).status

    const on = await seed(ctx, { title: 'Smoke auto summary', kind: 'recording', live: true, lines })
    await withAutoSummarize(ctx, true, () => finish(on))
    await waitFor(async () => (await status(on)) === 'summarized', 10000, 'the automatic summary')
    const done = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', on)
    assert(done.summary?.summary.includes('offline summary') === true, 'the summary is the companion’s')
    assert(done.summary?.participants.length === 0, 'no participants are invented')

    const off = await seed(ctx, { title: 'Smoke manual summary', kind: 'recording', live: true, lines })
    await withAutoSummarize(ctx, false, () => finish(off))
    await sleep(600)
    const kept = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', off)
    assert(kept.status === 'transcribed' && kept.summary === null, 'only the transcript is saved')
    await ctx.chrome.invoke('meetings', 'summarize', off)
    await waitFor(async () => (await status(off)) === 'summarized', 10000, 'the summary on request')
  },
}

const dictation: SmokeCheck = {
  name: 'meetings: composer dictation listens, shows the words, and Stop puts them at the caret (MV-07, DS-59)',
  async run(ctx) {
    const chat = await ctx.chrome.invoke<{ id: string }>('chats', 'create', {})
    ctx.tabs.openInternal(chatUrl(chat.id))
    // The page's composer settles first: a click while it still mounts would start a session it never shows.
    await ctx.chrome.until(`return ${CHAT}?.classList.contains('chat-view--empty')`, 8000, 'the empty chat page')
    await clickInChat(ctx, '.chat-primary--voice', 'voice as the primary button of an empty composer')
    await ctx.chrome.until(`return ${CHAT}?.querySelector('.chat-primary--send-transcript') && ${CHAT}?.querySelector('.chat-voice--stop') && ${CHAT}?.querySelector('.dict-bar--listening')`, 8000, 'the listening state')

    const status = await ctx.chrome.invoke<SpeechStatus>('speech', 'status')
    assert(status.active?.mode === 'dictation', 'a dictation session is running')
    const heard = 'pack a rain jacket'
    ctx.chrome.ui.send(UI.appEvent, { type: 'speech-session', id: status.active.id, purpose: 'dictation', event: { type: 'final', source: 'mic', text: heard, startMs: 0, endMs: 800 } })
    await ctx.chrome.until(`return ${CHAT}?.querySelector('.dict-bar__words')?.textContent.includes(${JSON.stringify(heard)})`, 5000, 'the heard words in the dictation bar')

    await clickInChat(ctx, '.chat-voice--stop', 'Stop')
    await ctx.chrome.until(`return (${CHAT}?.querySelector('.chat-composer__field')?.value ?? '').toLowerCase().includes(${JSON.stringify(heard)})`, 8000, 'the words in the composer')
    await ctx.chrome.until(`return ${CHAT}?.querySelector('.chat-primary--send') && ${CHAT}?.querySelector('.chat-voice:not(.chat-voice--stop)') && !${CHAT}?.querySelector('.dict-bar')`, 5000, 'send as primary and the mic as secondary once there is text')
    await typeInChat(ctx, '')
  },
}

const audioOnly: SmokeCheck = {
  name: 'meetings: a meeting recorded as audio only shows Audio only, why, its player and Transcribe, with no transcript or notes',
  async run(ctx) {
    const id = seededAudioOnly()
    ctx.tabs.openInternal('apex://meetings')
    await ctx.chrome.until(
      `return [...document.querySelectorAll('.mt-row')].some((r) => r.querySelector('.mt-row__title')?.textContent === ${JSON.stringify(AUDIO_ONLY)} && r.querySelector('.mt-badge')?.textContent === 'Audio only')`,
      8000,
      'the Audio only badge in the list',
    )
    ctx.tabs.openInternal(`apex://meetings/${id}`)
    // In the system's words: Windows has online speech recognition, a Mac Speech Recognition for Apex.
    const why = process.platform === 'win32' ? 'online speech recognition is off in Windows' : `Speech Recognition is off for ${BRAND_NAME}`
    await ctx.chrome.until(`return document.querySelector('.mt-head__title') && document.body.innerText.includes(${JSON.stringify(why)})`, 8000, 'why it was recorded as audio only')
    const page = await ctx.chrome.js<{ transcript: boolean; notes: boolean; ask: boolean; player: boolean; transcribe: boolean }>(`return {
      transcript: Boolean(document.getElementById('mt-transcript-heading')),
      notes: Boolean(document.querySelector('.mt-notes')),
      ask: [...document.querySelectorAll('.mt-head__actions button')].some((b) => b.textContent.includes('Ask about this meeting')),
      player: Boolean(document.querySelector('.mt-player audio')),
      transcribe: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Transcribe'),
    }`)
    assert(!page.transcript && !page.notes && !page.ask, `no transcript, notes or Ask on an audio-only meeting (${JSON.stringify(page)})`)
    assert(page.player && page.transcribe, `the player and Transcribe (${JSON.stringify(page)})`)
  },
}

const recovery: SmokeCheck = {
  name: 'meetings: a recording a crash left in parts is put back together on the next start',
  async run(ctx) {
    const lib = library()
    assert(!captureSmokeHooks()?.recorder.isLive(), 'nothing is recording (the store reloads from disk)')
    // As a crash leaves it: still live on disk, no audio.m4a, the helper's part beside it.
    const id = randomUUID()
    const dir = join(lib.store.root, id)
    const part = join(dir, '.audio.m4a.mic.0.part.aac')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ v: 1, id, kind: 'meeting', title: 'Smoke crashed recording', startedAt: Date.now() - 600_000, status: 'live', audioOnly: 'chosen', recordAudio: true }))
    writeFileSync(part, fakeM4a())
    lib.store.load(lib.summarizer.pending())
    assert(lib.store.get(id)?.status === 'finishing' && lib.store.recoverable().includes(id), 'it waits for its parts at start-up')
    await lib.recoverLeft()
    const d = lib.store.get(id)
    assert(d?.status === 'recorded' && d.hasAudio && d.durationMs >= 1000, `recorded with its audio (${JSON.stringify({ status: d?.status, hasAudio: d?.hasAudio, durationMs: d?.durationMs })})`)
    assert(existsSync(join(dir, 'audio.m4a')) && !existsSync(part), 'audio.m4a written, the part gone')
    ctx.tabs.openInternal(`apex://meetings/${id}`)
    await ctx.chrome.until(`return document.querySelector('.mt-player audio') && document.body.innerText.includes('Recorded as audio only')`, 8000, 'the recovered recording, playable')
  },
}

export const checks: SmokeCheck[] = [library_, exportMarkdown, attach, holdAndSend, autoSummary, dictation, audioOnly, recovery]

export const shots: ShotSpec[] = [
  {
    name: 'meetings-library',
    async run(ctx) {
      await seeded(ctx)
      ctx.tabs.openInternal('apex://meetings')
      await rowsInclude(ctx, STANDUP, 'the meetings list')
      await ctx.shot('meetings-library')
    },
  },
  {
    name: 'meeting-audio-only',
    async run(ctx) {
      const id = seededAudioOnly()
      ctx.tabs.openInternal(`apex://meetings/${id}`)
      await ctx.chrome.until(`return document.querySelector('.mt-player audio')`, 8000, 'the audio-only meeting page')
      await ctx.shot('meeting-audio-only')
    },
  },
  {
    name: 'meeting-detail',
    async run(ctx) {
      const { standup } = await seeded(ctx)
      ctx.tabs.openInternal(`apex://meetings/${standup}`)
      await ctx.chrome.until(`return document.querySelector('.mt-notes__summary') && document.querySelector('.mt-run__label')`, 8000, 'the meeting page')
      await ctx.shot('meeting-detail')
    },
  },
]
