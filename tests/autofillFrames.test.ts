/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { FrameLinker, childBox, composeChain, intersect, rectInTop, scaleRect, topBox } from '../src/main/autofill/frames'
import { MASK_PAD, maskBitmap, rectsToPixels } from '../src/main/autofill/mask'
import { MAX_RESOLVED_FIELDS, editsField, redactGuarded } from '../src/main/autofill/agentGuard'
import { FakeFrame } from './fixtures/autofill/fakes'

// Frame offsets for nested and cross-origin frames, the guarded
// rects the CaptureMasker paints over, and what the agent may read.

describe('frame offset composition', () => {
  const viewport = { width: 1000, height: 800 }

  it('chains child rects from the top frame down', () => {
    const box = composeChain(viewport, [
      { x: 100, y: 200, width: 600, height: 400 },
      { x: 20, y: 30, width: 300, height: 200 },
    ])
    expect(box).toMatchObject({ x: 120, y: 230 })
    expect(box.clip).toEqual({ x: 120, y: 230, width: 300, height: 200 })
    expect(rectInTop(box, { x: 10, y: 10, width: 100, height: 20 })).toEqual({ x: 130, y: 240, width: 100, height: 20 })
  })

  it('clips a nested frame to every ancestor', () => {
    const outer = childBox(topBox(viewport), { x: 900, y: 0, width: 400, height: 300 })
    expect(outer.clip.width).toBe(100)
    const inner = childBox(outer, { x: 50, y: 0, width: 200, height: 100 })
    expect(inner.clip).toEqual({ x: 950, y: 0, width: 50, height: 100 })
    // A field scrolled out of its frame is hidden, unclipped it still lines up.
    expect(rectInTop(inner, { x: 80, y: 10, width: 40, height: 20 })).toBeNull()
    expect(rectInTop(inner, { x: 80, y: 10, width: 40, height: 20 }, false)).toEqual({ x: 1030, y: 10, width: 40, height: 20 })
  })

  it('intersects and scales rects', () => {
    expect(intersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull()
    expect(scaleRect({ x: 10, y: 20, width: 30, height: 40 }, 1.5)).toEqual({ x: 15, y: 30, width: 45, height: 60 })
  })
})

describe('FrameLinker', () => {
  function tree(): { top: FakeFrame; mid: FakeFrame; leaf: FakeFrame; linker: FrameLinker } {
    const top = new FakeFrame('top', 'https://shop.example', 'https://shop.example/checkout', true)
    const mid = new FakeFrame('mid', 'https://pay.example', 'https://pay.example/box', false, top)
    const leaf = new FakeFrame('leaf', 'https://card.example', 'https://card.example/field', false, mid)
    let n = 0
    const linker = new FrameLinker({ viewport: () => ({ width: 1000, height: 800 }), ids: () => `nonce-${++n}`, timeoutMs: 20 })
    // Each frame posts its nonce to its parent, and the parent's preload reports the iframe's content box.
    mid.onSend = (c) => {
      if (c.type === 'probe-parent') queueMicrotask(() => linker.onProbe(top, c.nonce, { x: 100, y: 200, width: 600, height: 400 }))
    }
    leaf.onSend = (c) => {
      if (c.type === 'probe-parent') queueMicrotask(() => linker.onProbe(mid, c.nonce, { x: 20, y: 30, width: 300, height: 200 }))
    }
    return { top, mid, leaf, linker }
  }

  it('composes nested cross-origin frames through their parents', async () => {
    const { leaf, top, linker } = tree()
    expect(await linker.boxOf(top)).toMatchObject({ x: 0, y: 0 })
    expect(await linker.boxOf(leaf)).toMatchObject({ x: 120, y: 230 })
  })

  it('ignores an answer from a frame that is not the parent', async () => {
    const { mid, leaf, linker } = tree()
    mid.onSend = (c) => {
      if (c.type === 'probe-parent') queueMicrotask(() => linker.onProbe(leaf, c.nonce, { x: 0, y: 0, width: 10, height: 10 }))
    }
    expect(await linker.boxOf(mid)).toBeNull()
  })

  it('gives up on frames that never answer, and on destroyed ones', async () => {
    const { mid, leaf, linker } = tree()
    mid.onSend = null
    expect(await linker.boxOf(leaf)).toBeNull()
    leaf.live = false
    expect(await linker.boxOf(leaf)).toBeNull()
  })

  it('collects guarded rects and the focused guard from the frames that answer', async () => {
    const { top, mid, leaf, linker } = tree()
    top.onSend = (c) => {
      if (c.type === 'report-guarded') queueMicrotask(() => linker.onGuarded(top, [{ x: 5, y: 5, width: 50, height: 20 }], null))
    }
    const probe = leaf.onSend
    leaf.onSend = (c) => {
      probe?.(c)
      if (c.type === 'report-guarded') queueMicrotask(() => linker.onGuarded(leaf, [{ x: 10, y: 10, width: 100, height: 24 }], 'card'))
    }
    mid.live = false
    const replies = await linker.guarded([top, mid, leaf])
    expect(replies.map((r) => r.frame.token)).toEqual(['top', 'leaf'])
    expect(replies.find((r) => r.focused)?.focused).toBe('card')
  })

  it('settles every wait on dispose', async () => {
    const { top, linker } = tree()
    const pending = linker.guarded([top])
    linker.dispose()
    expect(await pending).toEqual([])
  })
})

describe('capture masking', () => {
  it('maps guarded DIP rects into bitmap pixels, padded', () => {
    const [r] = rectsToPixels([{ x: 100, y: 50, width: 200, height: 30 }], { x: 0, y: 0, width: 1000, height: 500 }, { width: 2000, height: 1000 })
    expect(r).toEqual({ x: (100 - MASK_PAD) * 2, y: (50 - MASK_PAD) * 2, width: (200 + MASK_PAD * 2) * 2, height: (30 + MASK_PAD * 2) * 2 })
    // A zoomed region shifts the rects by its origin.
    const [z] = rectsToPixels([{ x: 100, y: 50, width: 20, height: 10 }], { x: 90, y: 40, width: 100, height: 100 }, { width: 100, height: 100 }, 0)
    expect(z).toEqual({ x: 10, y: 10, width: 20, height: 10 })
    expect(rectsToPixels([{ x: 0, y: 0, width: 1, height: 1 }], { x: 0, y: 0, width: 0, height: 10 }, { width: 10, height: 10 })).toEqual([])
  })

  it('paints opaque rounded boxes in BGRA, leaving the rest alone', () => {
    const size = { width: 20, height: 10 }
    const bitmap = new Uint8Array(size.width * size.height * 4)
    maskBitmap(bitmap, size, [{ x: 2, y: 2, width: 12, height: 6 }], { r: 10, g: 20, b: 30 }, 2)
    const px = (x: number, y: number): number[] => Array.from(bitmap.slice((y * size.width + x) * 4, (y * size.width + x) * 4 + 4))
    expect(px(7, 5)).toEqual([30, 20, 10, 255])
    expect(px(0, 0)).toEqual([0, 0, 0, 0])
    expect(px(2, 2)).toEqual([0, 0, 0, 0]) // the rounded corner
    expect(px(18, 5)).toEqual([0, 0, 0, 0])
  })

  it('clamps rects that run off the bitmap', () => {
    const size = { width: 4, height: 4 }
    const bitmap = new Uint8Array(64)
    maskBitmap(bitmap, size, [{ x: -10, y: -10, width: 100, height: 100 }], { r: 1, g: 1, b: 1 }, 0)
    expect(bitmap.every((v, i) => (i % 4 === 3 ? v === 255 : v === 1))).toBe(true)
  })
})

describe('agent guarding in read_page', () => {
  const page = [
    'form "Checkout" [ref_1]',
    '  textbox "Email" [ref_2] value="robin@example.com"',
    '  textbox "Card number" [ref_3] value="4242 4242 4242 4242"',
    '  textbox "Password" [ref_4] value=<hidden>',
    '  textbox "Code" [ref_5] value="123456"',
    '  textbox "Security code" [ref_6] placeholder="CVC"',
    '  combobox "Month" [ref_7] value="07"',
    '  button "Pay" [ref_8]',
  ].join('\n')

  it('marks guarded fields and never prints their values', async () => {
    const asked: string[] = []
    const out = await redactGuarded(page, (ref) => {
      asked.push(ref)
      return Promise.resolve(ref === 'ref_5' ? 'otp' : ref === 'ref_7' ? true : null)
    })
    expect(out).toContain('textbox "Email" [ref_2] value="robin@example.com"')
    expect(out).toContain('textbox "Card number" [ref_3] guarded=card value=<hidden>')
    expect(out).toContain('textbox "Password" [ref_4] guarded=password value=<hidden>')
    expect(out).toContain('textbox "Code" [ref_5] guarded=otp value=<hidden>')
    expect(out).toContain('textbox "Security code" [ref_6] guarded=cvc placeholder="CVC"')
    expect(out).toContain('combobox "Month" [ref_7] guarded value=<hidden>')
    expect(out).toContain('button "Pay" [ref_8]')
    expect(out).not.toContain('4242')
    expect(out).not.toContain('123456')
    // Fields judged by their name need no lookup.
    expect(asked).toEqual(['ref_2', 'ref_5', 'ref_7'])
  })

  it('bounds the lookups per read', async () => {
    const many = Array.from({ length: MAX_RESOLVED_FIELDS + 10 }, (_, i) => `textbox "Field ${i}" [ref_${i}] value="x"`).join('\n')
    let calls = 0
    await redactGuarded(many, () => {
      calls++
      return Promise.resolve(null)
    })
    expect(calls).toBe(MAX_RESOLVED_FIELDS)
  })

  it('keeps output that has no fields as it is, and survives a failing lookup', async () => {
    expect(await redactGuarded('heading "Hello" [ref_1] level=1', () => Promise.resolve('card'))).toBe('heading "Hello" [ref_1] level=1')
    expect(await redactGuarded('textbox "Note" [ref_2] value="hi"', () => Promise.reject(new Error('stale')))).toBe('textbox "Note" [ref_2] value="hi"')
  })

  it('knows which keys edit a field', () => {
    expect(editsField({ key: 'a', modifiers: [] })).toBe(true)
    expect(editsField({ key: 'Backspace', modifiers: [] })).toBe(true)
    expect(editsField({ key: 'v', modifiers: ['meta'] })).toBe(true)
    expect(editsField({ key: 'Enter', modifiers: [] })).toBe(false)
    expect(editsField({ key: 'Tab', modifiers: [] })).toBe(false)
    expect(editsField({ key: 'a', modifiers: ['meta'] })).toBe(false)
  })
})
