/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import type { MeetingResolver } from '@shared/meetings'
import { AttachmentNotReadyError, isInlineAttachment, prepareAttachments, type PrepareDeps } from '../src/main/agent/attachments'
import { messageAttachmentsSchema } from '../src/main/agent/messageAttachments'

// A message's inline attachments as request content: screenshots become
// image blocks, meetings become one text block resolved at send time, the
// log keeps only references, and every engine gets the same blocks.

const MEETING = '44444444-4444-4444-8444-444444444444'
const REF = '55555555-5555-4555-8555-555555555555'
const PNG = 'iVBORw0KGgo='

function deps(ready = true): PrepareDeps & { resolver: MeetingResolver & { forPrompt: ReturnType<typeof vi.fn> } } {
  return {
    resolver: { forPrompt: vi.fn(async () => ({ title: 'Weekly sync', text: '<meeting title="Weekly sync">…</meeting>', ready })) },
    thumbnail: () => 'data:image/jpeg;base64,AAAA',
  }
}

describe('prepareAttachments', () => {
  it('turns screenshots into image blocks and meetings into text, in the order attached', async () => {
    const d = deps()
    const out = await prepareAttachments(
      [
        { kind: 'image', mediaType: 'image/png', data: PNG, label: 'Pricing page' },
        { kind: 'meeting', meetingId: MEETING },
        { kind: 'ref', id: REF },
      ],
      d,
    )
    expect(out.blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: '<meeting title="Weekly sync">…</meeting>' },
    ])
    expect(d.resolver.forPrompt).toHaveBeenCalledWith(MEETING)
    expect(out.refs.map((r) => [r.kind, r.name, r.thumbnail, r.sourceId])).toEqual([
      ['image', 'Pricing page', 'data:image/jpeg;base64,AAAA', undefined],
      ['meeting', 'Weekly sync', null, MEETING],
    ])
    // The log keeps a reference, never the screenshot or the transcript.
    expect(JSON.stringify(out.refs)).not.toContain(PNG)
    expect(out.rest).toEqual([{ kind: 'ref', id: REF }])
  })

  it('names an unlabelled screenshot and copes without a thumbnail', async () => {
    const out = await prepareAttachments([{ kind: 'image', mediaType: 'image/jpeg', data: PNG }], { resolver: null, thumbnail: () => null })
    expect(out.refs[0]).toMatchObject({ name: 'Screenshot', thumbnail: null, mediaType: 'image/jpeg', state: 'ready' })
  })

  it('refuses a meeting that is still being transcribed (MV-14), or when meetings are not available', async () => {
    await expect(prepareAttachments([{ kind: 'meeting', meetingId: MEETING }], deps(false))).rejects.toBeInstanceOf(AttachmentNotReadyError)
    await expect(prepareAttachments([{ kind: 'meeting', meetingId: MEETING }], { resolver: null, thumbnail: () => null })).rejects.toThrow(/aren’t available/)
  })

  it('returns nothing for a message without attachments', async () => {
    expect(await prepareAttachments(undefined, deps())).toEqual({ blocks: [], refs: [], rest: [] })
  })

  it('tells inline attachments from references', () => {
    expect(isInlineAttachment({ kind: 'meeting', meetingId: MEETING })).toBe(true)
    expect(isInlineAttachment({ kind: 'ref', id: REF })).toBe(false)
  })
})

describe('attachment IPC schema', () => {
  it('accepts screenshots, meetings and refs, and rejects anything else', () => {
    expect(messageAttachmentsSchema.safeParse([{ kind: 'image', mediaType: 'image/png', data: PNG }, { kind: 'meeting', meetingId: MEETING }]).success).toBe(true)
    expect(messageAttachmentsSchema.safeParse([{ kind: 'meeting', meetingId: 'nope' }]).success).toBe(false)
    expect(messageAttachmentsSchema.safeParse([{ kind: 'image', mediaType: 'image/gif', data: PNG }]).success).toBe(false)
    expect(messageAttachmentsSchema.safeParse([{ kind: 'image', mediaType: 'image/png', data: 'not base64!' }]).success).toBe(false)
    expect(messageAttachmentsSchema.safeParse([{ kind: 'meeting', meetingId: MEETING, extra: 1 }]).success).toBe(false)
  })
})
