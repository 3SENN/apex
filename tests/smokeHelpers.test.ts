/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { createSmokeClient, smokeReply } from '../src/main/smokeClient'
import { blit } from '../src/main/smokeKit'

// The smoke test's own helpers: the offline stand-in client and the
// compositing that puts page views into window screenshots.

type Stream = AsyncIterable<{ delta: { text: string } }> & { finalMessage(): Promise<{ content: Array<{ text: string }>; stop_reason: string }> }

function request(text: string): unknown {
  return { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: '<browser context>' }, { type: 'text', text }] }] }
}

async function collect(stream: Stream): Promise<string> {
  let text = ''
  for await (const event of stream) text += event.delta.text
  return text
}

describe('smoke client', () => {
  it('streams a canned reply for the last thing the user typed, not the browser context', async () => {
    const smoke = createSmokeClient()
    const api = smoke.client(null) as unknown as { beta: { messages: { stream(r: unknown, o: { signal: AbortSignal }): Stream } } }
    const stream = api.beta.messages.stream(request('Plan a picnic for Saturday'), { signal: new AbortController().signal })
    const text = await collect(stream)
    expect(text).toBe(smokeReply('Plan a picnic for Saturday'))
    expect(text.trim().endsWith('?')).toBe(true)
    const final = await stream.finalMessage()
    expect(final.content[0]?.text).toBe(text)
    expect(final.stop_reason).toBe('end_turn')
    expect(smoke.requests).toBe(1)
  })

  it('holds only the next reply until release, and a stop ends the wait', async () => {
    const smoke = createSmokeClient()
    const api = smoke.client(null) as unknown as { beta: { messages: { stream(r: unknown, o: { signal: AbortSignal }): Stream } } }
    smoke.hold()
    const held = collect(api.beta.messages.stream(request('Compare two laptops'), { signal: new AbortController().signal }))
    // The hold was taken by the first request; the second is not held.
    await expect(collect(api.beta.messages.stream(request('hello'), { signal: new AbortController().signal }))).resolves.toContain('hello')
    let done = false
    void held.then(() => (done = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(done).toBe(false)
    smoke.release()
    await expect(held).resolves.toContain('lighter one')

    smoke.hold()
    const abort = new AbortController()
    const stopped = collect(api.beta.messages.stream(request('x'), { signal: abort.signal }))
    abort.abort()
    await expect(stopped).rejects.toThrow('aborted')
  })
})

describe('blit', () => {
  const px = (buf: Buffer, width: number, x: number, y: number): number => buf[(y * width + x) * 4] ?? -1

  it('copies a page into the window at its bounds, clipping at the edges', () => {
    const target = Buffer.alloc(8 * 6 * 4, 0)
    const source = Buffer.alloc(4 * 3 * 4, 9)
    blit(target, 8, source, { x: 6, y: 4, width: 4, height: 3 }, 0)
    expect(px(target, 8, 6, 4)).toBe(9)
    expect(px(target, 8, 7, 5)).toBe(9)
    expect(px(target, 8, 5, 4)).toBe(0)
    // Nothing is written past the right or bottom edge.
    expect(target.length).toBe(8 * 6 * 4)
  })

  it('leaves rounded corners to the chrome underneath', () => {
    const target = Buffer.alloc(10 * 10 * 4, 0)
    const source = Buffer.alloc(10 * 10 * 4, 7)
    blit(target, 10, source, { x: 0, y: 0, width: 10, height: 10 }, 4)
    expect(px(target, 10, 0, 0)).toBe(0)
    expect(px(target, 10, 9, 9)).toBe(0)
    expect(px(target, 10, 5, 5)).toBe(7)
    expect(px(target, 10, 0, 5)).toBe(7)
  })
})
