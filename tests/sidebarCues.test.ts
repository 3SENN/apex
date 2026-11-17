/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '../src/shared/chats'
import { TRAFFIC_HIDE_PAST, TRAFFIC_INSET, trafficPlacement } from '../src/renderer/src/components/sidebar/logic/traffic'
import { chatMarks, detectArrival, downloadProgress, edgeCueLabel, headerDots, needsYou } from '../src/renderer/src/components/sidebar/logic/cues'

function chat(id: string, patch: Partial<ChatSummary> = {}): ChatSummary {
  return { id, title: id, createdAt: 0, updatedAt: 0, lastActiveAt: 0, routineId: null, companionId: 'pip', model: '', status: 'idle', unread: false, pinned: false, archived: false, needsInput: false, draft: false, ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS, ...patch }
}

describe('waiting chats', () => {
  it('counts approvals and questions as waiting for you', () => {
    expect(needsYou(chat('a', { status: 'needs-approval' }))).toBe(true)
    expect(needsYou(chat('a', { needsInput: true }))).toBe(true)
    expect(needsYou(chat('a', { status: 'running' }))).toBe(false)
  })
})

describe('arrival cue', () => {
  it('stays quiet on the first list', () => {
    expect(detectArrival(null, [chat('a', { unread: true })], new Set())).toBeNull()
  })

  it('fires when a chat becomes unread in the background', () => {
    const before = chatMarks([chat('a'), chat('b')])
    const next = [chat('a', { unread: true, lastActiveAt: 5 }), chat('b', { unread: true, lastActiveAt: 9 })]
    expect(detectArrival(before, next, new Set())?.id).toBe('b')
    // A chat you are looking at doesn't arrive.
    expect(detectArrival(before, next, new Set(['b']))?.id).toBe('a')
    expect(detectArrival(chatMarks(next), next, new Set())).toBeNull()
  })

  it('fires for a new routine run, not for a chat you just started', () => {
    const before = chatMarks([chat('a')])
    expect(detectArrival(before, [chat('a'), chat('r', { routineId: 'daily' })], new Set())?.id).toBe('r')
    expect(detectArrival(before, [chat('a'), chat('n')], new Set())).toBeNull()
    expect(detectArrival(before, [chat('a'), chat('d', { routineId: 'x', draft: true })], new Set())).toBeNull()
  })
})

describe('header dots and edge badges', () => {
  it('shows one dot per kind', () => {
    expect(headerDots([chat('a'), chat('b')])).toEqual({ needs: false, unread: false })
    expect(headerDots([chat('a', { unread: true }), chat('b', { needsInput: true })])).toEqual({ needs: true, unread: true })
  })

  it('labels the edge badges', () => {
    expect(edgeCueLabel('active')).toBe('Current page')
    expect(edgeCueLabel('needs')).toBe('Waiting for you')
  })
})

describe('downloads progress', () => {
  it('combines running downloads only', () => {
    expect(downloadProgress([])).toBeUndefined()
    expect(downloadProgress([{ state: 'completed', receivedBytes: 10, totalBytes: 10 }])).toBeUndefined()
    expect(downloadProgress([{ state: 'progressing', receivedBytes: 25, totalBytes: 100 }, { state: 'progressing', receivedBytes: 25, totalBytes: 100 }])).toBeCloseTo(0.25)
    expect(downloadProgress([{ state: 'progressing', receivedBytes: 5, totalBytes: 0 }])).toBeNull()
  })
})

describe('window controls', () => {
  it('sit in the header slot, inset and centred', () => {
    expect(trafficPlacement({ left: 0, top: 0, width: 72, height: 40 })).toEqual({ visible: true, x: TRAFFIC_INSET, y: 12 })
  })

  it('travel with the sliding sidebar, then hide once it has left the window', () => {
    const mid = trafficPlacement({ left: -10, top: 0, width: 72, height: 40 })
    expect(mid).toEqual({ visible: true, x: 4, y: 12 })
    expect(trafficPlacement({ left: -20, top: 0, width: 72, height: 40 })).toEqual({ visible: true, x: 0, y: 12 })
    expect(trafficPlacement({ left: -TRAFFIC_HIDE_PAST, top: 0, width: 72, height: 40 })).toEqual({ visible: false })
    expect(trafficPlacement({ left: -300, top: 0, width: 72, height: 40 })).toEqual({ visible: false })
  })

  it('hide without a slot', () => {
    expect(trafficPlacement(null)).toEqual({ visible: false })
    expect(trafficPlacement({ left: 10, top: 0, width: 0, height: 40 })).toEqual({ visible: false })
  })
})
