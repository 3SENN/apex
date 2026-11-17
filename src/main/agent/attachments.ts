/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import { THUMBNAIL_MAX_BYTES, type AttachmentRef, type RefAttachment } from '@shared/attachments'
import type { MessageAttachment, MessageAttachmentInput } from '@shared/chats'
import type { MeetingResolver } from '@shared/meetings'

// A message's inline attachments as request content: a screenshot becomes
// an image block and a meeting becomes one text block with its notes and
// labelled transcript, resolved at send time. Every engine takes the same
// blocks (another engine's backend turns them into its own input).
// The log keeps only a reference and a small thumbnail per attachment.
// Store references (`{ kind: 'ref' }`) pass through untouched, for the
// attachment store to resolve.

export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg' | 'image/png'; data: string } }
/** One block of a user message as both engines send it. */
export type UserBlock = TextBlock | ImageBlock

/** Thrown when an attached meeting is still being transcribed; the chrome holds such a message (MV-14). */
export class AttachmentNotReadyError extends Error {
  readonly meetingId: string

  constructor(meetingId: string, title: string) {
    super(`“${title}” is still being transcribed. Send again once its transcript is ready.`)
    this.name = 'AttachmentNotReadyError'
    this.meetingId = meetingId
  }
}

let meetingResolver: MeetingResolver | null = null

/** The meetings library sets this at start-up (the agent host is built before the speech, passwords and meetings features run). */
export function setMeetingResolver(resolver: MeetingResolver | null): void {
  meetingResolver = resolver
}

export interface PrepareDeps {
  resolver: MeetingResolver | null
  /** A small JPEG data URL for the log, or null when the image can't be read. */
  thumbnail(image: { mediaType: string; data: string }): string | null
}

/** The longest edge of a logged thumbnail. */
const THUMB_EDGE = 192

/** A small JPEG of a screenshot for the chat log, kept under THUMBNAIL_MAX_BYTES. */
export function electronThumbnail(image: { mediaType: string; data: string }): string | null {
  if (!nativeImage?.createFromBuffer) return null
  const source = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
  if (source.isEmpty()) return null
  const { width, height } = source.getSize()
  for (const [edge, quality] of [[THUMB_EDGE, 70], [128, 55], [96, 45]] as const) {
    const scale = Math.min(1, edge / Math.max(width, height, 1))
    const small = source.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'good' })
    const url = `data:image/jpeg;base64,${small.toJPEG(quality).toString('base64')}`
    if (url.length <= THUMBNAIL_MAX_BYTES) return url
  }
  return null
}

function defaultDeps(): PrepareDeps {
  return { resolver: meetingResolver, thumbnail: electronThumbnail }
}

export function isInlineAttachment(a: MessageAttachmentInput): a is MessageAttachment {
  return a.kind === 'image' || a.kind === 'meeting'
}

export interface PreparedMessage {
  /** Content blocks to place before the typed text, in the order attached. */
  blocks: UserBlock[]
  /** What the log keeps for each inline attachment (the 'user-message' event). */
  refs: AttachmentRef[]
  /** Store references, left for the attachment store to resolve. */
  rest: RefAttachment[]
}

/** Turns a message's attachments into blocks and log refs. Rejects with AttachmentNotReadyError for an unfinished meeting. */
export async function prepareAttachments(list: readonly MessageAttachmentInput[] | undefined, deps: PrepareDeps = defaultDeps()): Promise<PreparedMessage> {
  const out: PreparedMessage = { blocks: [], refs: [], rest: [] }
  for (const a of list ?? []) {
    if (a.kind === 'ref') {
      out.rest.push(a)
      continue
    }
    if (a.kind === 'image') {
      out.blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } })
      out.refs.push({
        id: randomUUID(),
        kind: 'image',
        name: a.label?.trim() || 'Screenshot',
        state: 'ready',
        error: null,
        size: Math.floor((a.data.length * 3) / 4),
        mediaType: a.mediaType,
        thumbnail: deps.thumbnail({ mediaType: a.mediaType, data: a.data }),
      })
      continue
    }
    if (!deps.resolver) throw new Error('Meetings aren’t available yet, so this meeting can’t be attached.')
    const meeting = await deps.resolver.forPrompt(a.meetingId)
    if (!meeting.ready) throw new AttachmentNotReadyError(a.meetingId, meeting.title)
    out.blocks.push({ type: 'text', text: meeting.text })
    out.refs.push({ id: randomUUID(), kind: 'meeting', name: meeting.title, state: 'ready', error: null, size: meeting.text.length, mediaType: 'text/plain', thumbnail: null, sourceId: a.meetingId })
  }
  return out
}
