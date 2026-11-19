/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { prepareAttachments, type PrepareDeps } from '../src/main/agent/attachments'
import { userLine } from '../src/engines/claude-code/main/streamJson'

// A message's inline attachments on Claude Code: the same blocks as the API
// key, written into the stream-json user line (tests/attachments.test.ts has
// the rest).

const MEETING = '44444444-4444-4444-8444-444444444444'
const PNG = 'iVBORw0KGgo='

const deps = (): PrepareDeps => ({
  resolver: { forPrompt: vi.fn(async () => ({ title: 'Weekly sync', text: '<meeting title="Weekly sync">…</meeting>', ready: true })) },
  thumbnail: () => 'data:image/jpeg;base64,AAAA',
})

describe('Claude Code mapping', () => {
  it('writes image and text blocks into the stream-json user line', async () => {
    const out = await prepareAttachments([{ kind: 'image', mediaType: 'image/png', data: PNG }, { kind: 'meeting', meetingId: MEETING }], deps())
    const line = JSON.parse(userLine([...out.blocks, { type: 'text', text: 'What did we decide?' }])) as { type: string; message: { content: Array<{ type: string }> } }
    expect(line.type).toBe('user')
    expect(line.message.content.map((b) => b.type)).toEqual(['image', 'text', 'text'])
  })
})
