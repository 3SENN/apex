/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '@shared/attachments'
import { withReplyRef } from '../src/renderer/src/chat/logic/intake'

// Main sends its 'attachments' event for every change before it replies to
// add, and a quote is prepared at once: its "ready" event can land before the
// reply that still says "preparing". The chip must stay ready (the reader's
// Ask quoted the article in a chip stuck on "Preparing…", which held the send).

const ref = (id: string, state: AttachmentRef['state']): AttachmentRef => ({ id, kind: 'selection', name: 'How Tide Pools Keep Time', state, error: null, size: 10, mediaType: 'text/plain', thumbnail: null })

describe('composer intake: a reply never undoes a newer event', () => {
  it('keeps the ready chip an event brought before the add reply (still preparing)', () => {
    expect(withReplyRef([ref('a1', 'ready')], ref('a1', 'preparing'))).toBeNull()
  })

  it('keeps a retry’s newer state too', () => {
    expect(withReplyRef([ref('a1', 'failed'), ref('a2', 'ready')], ref('a2', 'preparing'))).toBeNull()
  })

  it('adds the reply’s ref when no event brought it yet', () => {
    expect(withReplyRef([ref('a1', 'ready')], ref('a2', 'preparing'))?.map((a) => [a.id, a.state])).toEqual([
      ['a1', 'ready'],
      ['a2', 'preparing'],
    ])
  })
})
