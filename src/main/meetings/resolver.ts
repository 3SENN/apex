/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeetingDetail, MeetingResolver } from '@shared/meetings'
import { transcriptLines } from './summarize'
import { UNSETTLED, type MeetingFileStore } from './store'

// What a chat gets for an attached meeting: one text block holding the
// notes and the labelled transcript, resolved at send time. A meeting whose
// transcript is still being finished is not ready; the chrome holds the
// message until it is (MV-14) and main never sends half a transcript.

/** Keeps a request well under its size limit; the middle of a very long meeting is what gets cut. */
export const MEETING_PROMPT_MAX = 300_000

function attr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
}

function list(heading: string, items: readonly string[]): string {
  return items.length ? `${heading}:\n${items.map((i) => `- ${i}`).join('\n')}\n` : ''
}

/** The meeting as the model reads it. Labels follow the audio source, which the text says. */
export function meetingPromptText(d: MeetingDetail, max = MEETING_PROMPT_MAX): string {
  const date = new Date(d.startedAt).toISOString().slice(0, 16).replace('T', ' ')
  const minutes = Math.max(1, Math.round(d.durationMs / 60_000))
  const s = d.summary
  const notes = s
    ? [
        s.summary ? `Summary:\n${s.summary}\n` : '',
        list('Takeaways', s.takeaways),
        list('Decisions', s.decisions),
        list('Action items', s.actionItems.map((a) => (a.owner ? `${a.text} (${a.owner})` : a.text))),
        list('Participants', s.participants),
      ].join('')
    : ''
  let transcript = transcriptLines(d).join('\n')
  if (transcript.length > max) {
    const half = Math.floor(max / 2)
    transcript = `${transcript.slice(0, half)}\n[… the middle of this long transcript was left out …]\n${transcript.slice(-half)}`
  }
  const legend = `Transcript, labelled by audio source rather than by voice: "${d.labels.mic}" is the person's own microphone, "${d.labels.system}" is everyone else.`
  // Recorded as audio only: there is no transcript to read, so the companion can say so (and offer to transcribe it).
  if (d.status === 'recorded') return `<meeting title="${attr(d.title)}" date="${date}" minutes="${minutes}">\n(recorded as audio only, with no transcript; the person can transcribe it from Meetings)\n</meeting>`
  return `<meeting title="${attr(d.title)}" date="${date}" minutes="${minutes}">\n${notes}${notes ? '\n' : ''}${legend}\n${transcript || '(no speech was transcribed)'}\n</meeting>`
}

export function createMeetingResolver(store: MeetingFileStore): MeetingResolver {
  return {
    async forPrompt(id) {
      const detail = store.get(id)
      if (!detail) throw new Error('That meeting no longer exists.')
      return { title: detail.title, text: meetingPromptText(detail), ready: !UNSETTLED.includes(detail.status) }
    },
  }
}
