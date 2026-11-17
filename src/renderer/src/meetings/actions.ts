/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeetingSummary } from '@shared/meetings'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import { attachToDraft } from '../chat/attachments/drafts'
import { t } from '@shared/i18n/core'
import { showPopoverMenu, toast, type PopoverAnchor, type PopoverItem } from '../ui'

// What a meeting row or the detail page can do (MV-12, MV-13): summarise,
// transcribe again, attach to a chat (a recent one or a new one), export,
// and delete after confirmation. Errors come back as toasts.

type Meeting = Pick<MeetingSummary, 'id' | 'title'>

/** Opens a chat with the meeting attached to its next message (CH-06); a new chat when none is given. */
export async function askAboutMeeting(meeting: Meeting, chatId?: string): Promise<void> {
  try {
    const id = chatId ?? (await call('chats', 'create', {})).id
    if (!attachToDraft(id, { attachment: { kind: 'meeting', meetingId: meeting.id }, label: meeting.title })) {
      toast.show({ message: t('meetings.attach.full'), tone: 'error' })
      return
    }
    await call('pages', 'open', chatUrl(id))
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

/** A popover of recent chats plus "New chat"; the pick gets the meeting attached. */
export async function attachToChat(meeting: Meeting, anchor: PopoverAnchor): Promise<void> {
  let recent: Array<{ id: string; title: string }> = []
  try {
    recent = (await call('chats', 'list'))
      .filter((c) => !c.archived && !c.routineId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, 8)
      .map((c) => ({ id: c.id, title: c.title }))
  } catch {
    recent = []
  }
  const items: PopoverItem[] = [
    { id: 'new', label: t('meetings.attach.newChat'), kind: 'create' },
    ...(recent.length ? [{ id: 'sep', label: '', kind: 'separator' as const }, { id: 'recent', label: t('meetings.attach.recent'), kind: 'header' as const }] : []),
    ...recent.map((c) => ({ id: `chat:${c.id}`, label: c.title, keywords: c.title })),
  ]
  const picked = await showPopoverMenu(items, anchor, { label: t('meetings.attach.pick'), width: 300, search: recent.length > 5 ? { placeholder: t('meetings.attach.search') } : undefined })
  if (!picked) return
  if (picked === 'new') await askAboutMeeting(meeting)
  else if (picked.startsWith('chat:')) await askAboutMeeting(meeting, picked.slice('chat:'.length))
}

export async function summarizeMeeting(id: string): Promise<void> {
  try {
    await call('meetings', 'summarize', id)
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

/** Transcribes a meeting from its audio: the first time for one recorded as audio only (`first`), else again. */
export async function retranscribeMeeting(id: string, first = false): Promise<void> {
  try {
    await call('meetings', 'retranscribe', id)
    toast.show({ message: t(first ? 'meetings.transcribe.done' : 'meetings.retranscribe.done'), tone: 'success' })
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

export async function exportMeetingFile(id: string, format: 'markdown' | 'audio'): Promise<void> {
  try {
    const path = await call('meetings', 'exportFile', id, format)
    if (path) toast.show({ message: t('meetings.export.saved', { name: path.split(/[\\/]/).pop() ?? path }), tone: 'success' })
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

/** Confirms, then moves the meeting to the Trash. Resolves true when it went. */
export async function deleteMeeting(meeting: Meeting, confirm: (o: { title: string; message: string; confirmLabel: string; destructive: boolean }) => Promise<boolean>): Promise<boolean> {
  const ok = await confirm({ title: t('meetings.delete.title', { title: meeting.title }), message: t('meetings.delete.message'), confirmLabel: t('meetings.delete.confirm'), destructive: true })
  if (!ok) return false
  try {
    await call('meetings', 'remove', meeting.id)
    toast.show({ message: t('meetings.delete.done') })
    return true
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
    return false
  }
}
