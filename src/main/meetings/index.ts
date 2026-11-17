/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { UNSETTLED_STATUSES, type MeetingResolver, type MeetingStore, type MeetingSummarizer, type MeetingsServices } from '@shared/meetings'
import { SpeechError, type SpeechBroker } from '@shared/speech'
import type { AppContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { registerExportSource } from '../exporter'
import { registerStorageCategory } from '../storage'
import { setMeetingResolver } from '../agent/attachments'
import { exportMeeting, meetingMarkdown } from './export'
import { handleMediaProtocol } from './media'
import { createMeetingResolver } from './resolver'
import { MeetingFileStore } from './store'
import { FileMeetingSummarizer } from './summarize'

// The meetings library's entry point: the store under
// userData/meetings, the summarizer on ctx.quick, the resolver chats use for
// attached meetings, the atelier-media handler, the `meeting-recordings`
// storage category and the `meetings` service. Changes reach the chrome as
// `meetings` (the list) and `meeting-live` (one meeting's new lines).

export interface MeetingsLibrarySetup {
  store: MeetingStore
  summarizer: MeetingSummarizer
  resolver: MeetingResolver
  services: MeetingsServices
  dispose(): void
}

/** How often the queued summaries check for an engine (another engine can sign in without any Atelier event). */
const PENDING_RETRY_MS = 5 * 60_000
/** How long a discussion waits for a transcript that is still being finished. */
const DISCUSS_WAIT_MS = 120_000

let current: { store: MeetingFileStore; summarizer: FileMeetingSummarizer; recoverLeft(): Promise<void> } | null = null

// Smoke hook: the next path a save dialog returns under ATELIER_SMOKE, so an export never waits on a real dialog.
const smokeSaves: string[] = []
export const smokeMeetings = {
  queueSave(path: string): void {
    smokeSaves.push(path)
  },
}

/** The running library, for the smoke checks (seeding and reading back); null before start-up. */
export function meetingsLibrary(): { store: MeetingFileStore; summarizer: FileMeetingSummarizer; recoverLeft(): Promise<void> } | null {
  return current
}

function waitSettled(store: MeetingFileStore, id: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): boolean => {
      const status = store.status(id)
      if (status === null) {
        done()
        reject(new Error(mainT('meetings.error.gone')))
        return true
      }
      if (!UNSETTLED_STATUSES.includes(status)) {
        done()
        resolve()
        return true
      }
      return false
    }
    const onChange = (changed: string): void => {
      if (changed === id) check()
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error(mainT('meetings.error.stillFinishing')))
    }, ms)
    const done = (): void => {
      clearTimeout(timer)
      store.off('changed', onChange)
    }
    store.on('changed', onChange)
    check()
  })
}

export function setupMeetingsLibrary(ctx: AppContext, deps: { broker: SpeechBroker }): MeetingsLibrarySetup {
  const root = join(ctx.dataDir, 'meetings')
  const store = new MeetingFileStore(root, {
    labels: { you: mainT('meetings.label.you'), others: mainT('meetings.label.others') },
    trash: (path) => shell.trashItem(path),
  })
  const summarizer = new FileMeetingSummarizer({ store, quick: ctx.quick, queuePath: join(root, 'pending.json') })
  store.load(summarizer.pending())
  const resolver = createMeetingResolver(store)

  // Recordings a session never finished (Atelier crashed, was force quit or lost power mid-meeting):
  // the helper puts the parts it left back together, one meeting at a time. Parts it can't use
  // stay for the next start.
  const recoverLeft = async (): Promise<void> => {
    for (const id of store.recoverable()) {
      try {
        const r = await deps.broker.recoverRecording(store.audioPathFor(id))
        if (r.error) log.warn('meetings', 'A recording left behind could not be put back together', { id, error: r.error })
        else log.info('meetings', 'Put a recording left behind back together', { id, bytes: r.audio?.bytes ?? 0 })
        store.recovered(id, r.audio ? { bytes: r.audio.bytes, durationMs: r.durationMs } : null)
      } catch (err) {
        log.warn('meetings', 'Putting a recording left behind back together failed', { id, error: String(err) })
        store.recovered(id, null)
      }
    }
  }
  if (store.recoverable().length > 0) void recoverLeft()
  current = { store, summarizer, recoverLeft }
  setMeetingResolver(resolver)

  // The list goes out at most a few times a second; live lines go out as they come.
  let listTimer: ReturnType<typeof setTimeout> | null = null
  const onChanged = (): void => {
    if (listTimer) return
    listTimer = setTimeout(() => {
      listTimer = null
      ctx.broadcast({ type: 'meetings', items: store.list() })
    }, 150)
  }
  store.on('changed', onChanged)
  store.on('live', (c) => ctx.broadcast({ type: 'meeting-live', id: c.id, appended: c.appended, live: c.live, status: c.status }))

  // ST-20: with auto-summarize on, a finished meeting is summarised straight away (a request the recorder also makes joins this one).
  store.on('finished', (id) => {
    if (!ctx.settings.get().transcription.autoSummarize) return
    void summarizer.request(id).catch((err: unknown) => log.warn('meetings', 'Summarising a finished meeting failed', { id, error: String(err) }))
  })

  // Queued summaries run once an engine is ready: at start-up, after a settings change (a new key or engine), and on a slow timer.
  let settingsTimer: ReturnType<typeof setTimeout> | null = null
  const onSettings = (): void => {
    if (settingsTimer) clearTimeout(settingsTimer)
    settingsTimer = setTimeout(() => void summarizer.flush(), 1000)
  }
  ctx.settings.on('changed', onSettings)
  const retry = setInterval(() => void summarizer.flush(), PENDING_RETRY_MS)
  retry.unref?.()
  const startTimer = setTimeout(() => void summarizer.flush(), 4000)

  // Atelier-media on the default session, which the chrome, its overlays and the floats share.
  const unhandleMedia = handleMediaProtocol(session.defaultSession, ctx.dataDir)

  // ST-53: meeting recordings in the Storage overview.
  const unregisterStorage = registerStorageCategory({
    id: 'meeting-recordings',
    label: mainT('meetings.storage.recordings'),
    order: 30,
    measure: async () => store.storage().bytes,
  })

  // The export dialog (CH-36) reads transcripts through this.
  registerExportSource('transcript', {
    title: (id) => store.get(id)?.title ?? mainT('meetings.untitled'),
    markdown: (id) => {
      const detail = store.get(id)
      if (!detail) throw new Error(mainT('meetings.error.gone'))
      return meetingMarkdown(detail)
    },
  })

  const need = (id: string) => {
    const detail = store.get(id)
    if (!detail) throw new Error(mainT('meetings.error.gone'))
    return detail
  }

  let retranscribing: string | null = null
  const retranscribe = async (id: string): Promise<void> => {
    const detail = need(id)
    if (!detail.hasAudio) throw new Error(mainT('meetings.error.noAudioToTranscribe'))
    if (UNSETTLED_STATUSES.includes(detail.status) || detail.status === 'summarizing') throw new Error(mainT('meetings.error.busy'))
    if (retranscribing) throw new Error(mainT('meetings.error.oneAtATime'))
    retranscribing = id
    const before = detail.status
    const segments: Array<{ source: 'mic' | 'system'; text: string; startMs: number; endMs: number }> = []
    store.setStatus(id, 'finishing')
    store.setProgress(id, 0)
    let fatal: string | null = null
    try {
      await deps.broker.transcribeFile(store.audioPathFor(id), (e) => {
        if (e.type === 'progress') store.setProgress(id, e.fraction)
        else if (e.type === 'final') segments.push({ source: e.source, text: e.text, startMs: e.startMs, endMs: e.endMs })
        else if (e.type === 'error' && e.fatal) fatal = e.message
      })
      if (fatal) throw new Error(fatal)
      if (segments.length === 0) throw new Error(mainT('meetings.error.noSpeech'))
      store.replaceTranscript(id, segments)
      store.setProgress(id, null)
      store.setStatus(id, 'transcribed')
      if (ctx.settings.get().transcription.autoSummarize) void summarizer.request(id).catch((err: unknown) => log.warn('meetings', 'Summarising after transcribing again failed', { id, error: String(err) }))
    } catch (err) {
      store.setProgress(id, null)
      // The old transcript is untouched; the meeting goes back to how it was.
      store.setStatus(id, before)
      if (err instanceof SpeechError && err.code === 'speech-denied') throw new Error(mainT('capture.error.speechDenied'))
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      retranscribing = null
    }
  }

  const services: MeetingsServices = {
    meetings: {
      list: (f) => store.list(f ?? {}),
      get: (id) => need(id),
      rename: (id, title) => store.rename(id, title),
      renameLabel: (id, source, label) => store.renameLabel(id, source, label),
      summarize: (id) => summarizer.request(id),
      retranscribe,
      exportFile: async (id, format) =>
        exportMeeting(need(id), format, {
          downloads: app.getPath('downloads'),
          audioPath: (mid) => store.audioPathFor(mid),
          save: async (o) => {
            if (ctx.smoke) return smokeSaves.shift() ?? null
            const parent = BrowserWindow.getFocusedWindow()
            const result = parent ? await dialog.showSaveDialog(parent, o) : await dialog.showSaveDialog(o)
            return result.canceled || !result.filePath ? null : result.filePath
          },
        }),
      remove: (id) => {
        // Validated synchronously so the page hears "still recording" at once; the move to the Trash finishes on its own.
        const status = store.status(id)
        if (status === null) throw new Error(mainT('meetings.error.gone'))
        if (UNSETTLED_STATUSES.includes(status)) throw new Error(mainT('meetings.error.stopFirst'))
        summarizer.forget(id)
        void store.remove(id).catch((err: unknown) => log.warn('meetings', 'Deleting a meeting failed', { id, error: String(err) }))
      },
      storage: () => store.storage(),
      discuss: async (id, companionId) => {
        await waitSettled(store, id, DISCUSS_WAIT_MS)
        const detail = need(id)
        return ctx.agent.start(mainT('meetings.discuss.opener', { title: detail.title }), companionId ? { companionId } : {}, [{ kind: 'meeting', meetingId: id }])
      },
    },
  }

  return {
    store,
    summarizer,
    resolver,
    services,
    dispose: () => {
      if (listTimer) clearTimeout(listTimer)
      if (settingsTimer) clearTimeout(settingsTimer)
      clearTimeout(startTimer)
      clearInterval(retry)
      ctx.settings.off('changed', onSettings)
      store.removeAllListeners()
      unhandleMedia()
      unregisterStorage()
      setMeetingResolver(null)
      current = null
    },
  }
}
