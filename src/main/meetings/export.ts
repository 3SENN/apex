/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeetingDetail } from '@shared/meetings'
import { mainT } from '../i18n/mainT'

// Exporting a meeting (MV-12): Markdown with the notes and the
// labelled transcript, or the kept audio, through a save dialog. The export
// dialog (CH-36) takes over the Markdown through registerExportSource('transcript').

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`
}

/** A file name from a title: no path characters, never empty. */
export function safeFileName(title: string, ext: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Meeting'
  return `${base}.${ext}`
}

/** The meeting as Markdown: title, date, participants, notes, then the transcript labelled by source. */
export function meetingMarkdown(d: MeetingDetail, locale?: string): string {
  const out: string[] = [`# ${d.title}`, '']
  const date = new Date(d.startedAt).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' })
  const minutes = Math.max(1, Math.round(d.durationMs / 60_000))
  out.push(`${date} · ${mainT('meetings.export.minutes', { count: minutes })}`, '')
  const s = d.summary
  if (s) {
    if (s.participants.length) out.push(`**${mainT('meetings.detail.participants')}:** ${s.participants.join(', ')}`, '')
    if (s.summary) out.push(`## ${mainT('meetings.detail.summary')}`, '', s.summary, '')
    if (s.takeaways.length) out.push(`## ${mainT('meetings.detail.takeaways')}`, '', ...s.takeaways.map((t) => `- ${t}`), '')
    if (s.decisions.length) out.push(`## ${mainT('meetings.detail.decisions')}`, '', ...s.decisions.map((t) => `- ${t}`), '')
    if (s.actionItems.length) out.push(`## ${mainT('meetings.detail.actionItems')}`, '', ...s.actionItems.map((a) => `- [ ] ${a.text}${a.owner ? ` (${a.owner})` : ''}`), '')
  }
  out.push(`## ${mainT('meetings.detail.transcript')}`, '')
  if (d.segments.length === 0) out.push(`_${mainT('meetings.detail.noTranscript')}_`)
  for (const seg of d.segments) out.push(`**${d.labels[seg.source]}** [${clock(seg.startMs)}]: ${seg.text}`, '')
  return `${out.join('\n').trimEnd()}\n`
}

export interface ExportDeps {
  /** A save dialog; resolves to the chosen path or null. */
  save(o: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  downloads: string
  audioPath(id: string): string
}

/** Writes the chosen export; resolves to its path, or null when the dialog was cancelled. */
export async function exportMeeting(d: MeetingDetail, format: 'markdown' | 'audio', deps: ExportDeps): Promise<string | null> {
  if (format === 'audio') {
    const source = deps.audioPath(d.id)
    if (!d.hasAudio || !existsSync(source)) throw new Error(mainT('meetings.export.noAudio'))
    const path = await deps.save({ defaultPath: join(deps.downloads, safeFileName(d.title, 'm4a')), filters: [{ name: mainT('meetings.export.audioFilter'), extensions: ['m4a'] }] })
    if (!path) return null
    copyFileSync(source, path)
    return path
  }
  const path = await deps.save({ defaultPath: join(deps.downloads, safeFileName(d.title, 'md')), filters: [{ name: 'Markdown', extensions: ['md'] }] })
  if (!path) return null
  writeFileSync(path, meetingMarkdown(d), 'utf8')
  return path
}
