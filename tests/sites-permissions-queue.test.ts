/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { CaptureTracker, anyCapture } from '../src/main/capture'
import { PromptQueue, type PromptAnswer, type PromptHandle, type QueuedPrompt } from '../src/main/promptQueue'

// OV-11 (one prompt per identical request, one at a time per tab, gone with
// the tab or when the agent takes over) and what each tab captures.

interface Shown {
  prompt: QueuedPrompt<string>
  answer(a: PromptAnswer | null): void
  closed: boolean
}

function queue(): { q: PromptQueue<string>; shown: Shown[] } {
  const shown: Shown[] = []
  const q = new PromptQueue<string>((prompt): PromptHandle => {
    let answer!: (a: PromptAnswer | null) => void
    const result = new Promise<PromptAnswer | null>((r) => (answer = r))
    const entry: Shown = { prompt, answer, closed: false }
    shown.push(entry)
    return {
      result,
      close: () => {
        entry.closed = true
        answer(null)
      },
    }
  })
  return { q, shown }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the permission prompt queue', () => {
  it('shares one prompt between identical requests', async () => {
    const { q, shown } = queue()
    const a = q.ask({ key: 'k', tabId: 't1', props: 'camera' })
    const b = q.ask({ key: 'k', tabId: 't1', props: 'camera' })
    expect(shown).toHaveLength(1)
    expect(q.pending()).toEqual([{ key: 'k', tabId: 't1', open: true, waiters: 2 }])
    shown[0]!.answer({ allow: true, remember: false })
    expect(await a).toEqual({ allow: true, remember: false })
    expect(await b).toEqual({ allow: true, remember: false })
    expect(q.pending()).toEqual([])
  })

  it('shows one prompt per tab at a time, in arrival order', async () => {
    const { q, shown } = queue()
    const first = q.ask({ key: 'camera', tabId: 't1', props: 'camera' })
    const second = q.ask({ key: 'location', tabId: 't1', props: 'location' })
    const other = q.ask({ key: 'camera', tabId: 't2', props: 'camera' })
    expect(shown.map((s) => `${s.prompt.tabId}:${s.prompt.props}`)).toEqual(['t1:camera', 't2:camera'])
    shown[0]!.answer({ allow: false, remember: true })
    expect(await first).toEqual({ allow: false, remember: true })
    await tick()
    expect(shown.map((s) => `${s.prompt.tabId}:${s.prompt.props}`)).toEqual(['t1:camera', 't2:camera', 't1:location'])
    shown[2]!.answer(null)
    expect(await second).toBeNull()
    shown[1]!.answer({ allow: true, remember: false })
    expect(await other).toEqual({ allow: true, remember: false })
  })

  it('ends every prompt of a tab when it closes or the agent takes over', async () => {
    const { q, shown } = queue()
    const open = q.ask({ key: 'a', tabId: 't1', props: 'a' })
    const waiting = q.ask({ key: 'b', tabId: 't1', props: 'b' })
    const elsewhere = q.ask({ key: 'a', tabId: 't2', props: 'a' })
    q.cancelTab('t1')
    expect(await open).toBeNull()
    expect(await waiting).toBeNull()
    expect(shown[0]!.closed).toBe(true)
    await tick()
    // The waiting prompt never showed, and the other tab's prompt is untouched.
    expect(shown.map((s) => s.prompt.key)).toEqual(['a', 'a'])
    expect(q.pending()).toEqual([{ key: 'a', tabId: 't2', open: true, waiters: 1 }])
    shown[1]!.answer({ allow: true, remember: false })
    expect(await elsewhere).toEqual({ allow: true, remember: false })
  })

  it('treats a prompt that could not open as dismissed', async () => {
    const q = new PromptQueue<string>(() => {
      throw new Error('no overlay')
    })
    expect(await q.ask({ key: 'k', tabId: 't1', props: 'x' })).toBeNull()
    expect(q.pending()).toEqual([])
  })
})

describe('the capture tracker', () => {
  /** A tracker report for one document: camera, microphone, screen as [seen, live]. */
  const doc = (id: string, seen: [number, number, number], live: [number, number, number], extra: { frame?: string; gone?: boolean } = {}) => ({
    doc: id,
    frame: extra.frame ?? `frame-${id}`,
    seen: { camera: seen[0], microphone: seen[1], screen: seen[2] },
    live: { camera: live[0], microphone: live[1], screen: live[2] },
    gone: extra.gone ?? false,
  })

  it('counts a granted kind as live until the page says otherwise', () => {
    const t = new CaptureTracker()
    const changes: string[] = []
    t.on('changed', (id) => changes.push(id))
    t.grant('t1', ['camera', 'microphone'])
    expect(t.state('t1')).toEqual({ camera: true, microphone: true, screen: false })
    t.report('t1', doc('d1', [1, 1, 0], [0, 1, 0]))
    expect(t.state('t1')).toEqual({ camera: false, microphone: true, screen: false })
    expect(t.reported('t1')).toBe(true)
    expect(changes).toEqual(['t1', 't1'])
  })

  it('ignores reports from tabs Apex never granted anything', () => {
    const t = new CaptureTracker()
    t.report('t9', doc('d1', [1, 1, 1], [1, 1, 1]))
    expect(anyCapture(t.state('t9'))).toBe(false)
    expect(t.active()).toEqual([])
  })

  it('ends kinds on Stop and everything on navigation', () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera', 'microphone'])
    t.clear('t1', ['camera'])
    expect(t.state('t1')).toEqual({ camera: false, microphone: true, screen: false })
    t.clear('t1')
    expect(t.state('t1')).toEqual({ camera: false, microphone: false, screen: false })
    expect(t.reported('t1')).toBe(false)
  })

  it('keeps a shared tab marked until the capture of it ends', () => {
    const t = new CaptureTracker()
    t.grant('caller', ['screen'], 'shared')
    expect(t.sharedTab('caller')).toBe('shared')
    expect(t.isShared('shared')).toBe(true)
    expect(t.active()).toEqual(['caller'])
    t.report('caller', doc('d1', [0, 0, 1], [0, 0, 0]))
    expect(t.isShared('shared')).toBe(false)
    expect(t.sharedTab('caller')).toBeNull()
  })

  it('shares a window or screen without naming a tab', () => {
    const t = new CaptureTracker()
    t.grant('caller', ['screen'])
    expect(t.state('caller').screen).toBe(true)
    expect(t.sharedTab('caller')).toBeNull()
  })

  it('keeps the icon on for a capture no tracker saw (an iframe without one), whatever the others report', () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera'])
    t.report('t1', doc('top', [1, 0, 0], [1, 0, 0]))
    // A second camera grant, used in a frame no tracker covers.
    t.grant('t1', ['camera'])
    t.report('t1', doc('top', [1, 0, 0], [0, 0, 0]))
    expect(t.state('t1').camera).toBe(true)
    expect(t.untracked('t1', ['camera'])).toBe(true)
  })

  it("adds up every frame's documents: a same-tab iframe's live camera keeps it on", () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera'])
    t.grant('t1', ['camera'])
    t.report('t1', doc('top', [1, 0, 0], [0, 0, 0]))
    t.report('t1', doc('iframe', [1, 0, 0], [1, 0, 0]))
    expect(t.state('t1').camera).toBe(true)
    expect(t.holds('t1', ['camera'])).toBe(true)
    t.report('t1', doc('iframe', [1, 0, 0], [0, 0, 0]))
    expect(t.state('t1').camera).toBe(false)
  })

  it("ends a document's tracks when it goes away or another document takes its frame, and ignores it after", () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera', 'microphone'])
    t.report('t1', doc('old', [1, 1, 0], [1, 1, 0], { frame: 'f1' }))
    t.report('t1', doc('new', [0, 0, 0], [0, 0, 0], { frame: 'f1' }))
    expect(t.state('t1')).toEqual({ camera: false, microphone: false, screen: false })
    t.grant('t1', ['microphone'])
    t.report('t1', doc('widget', [0, 1, 0], [0, 1, 0], { frame: 'f2' }))
    t.report('t1', doc('widget', [0, 1, 0], [0, 1, 0], { frame: 'f2', gone: true }))
    expect(t.state('t1').microphone).toBe(false)
    // A late report from a document that went away can't bring its tracks back.
    t.report('t1', doc('widget', [0, 1, 0], [0, 1, 0], { frame: 'f2' }))
    expect(t.state('t1').microphone).toBe(false)
  })

  it("never lets sightings from before Stop answer for a capture granted after it", () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera'])
    t.report('t1', doc('top', [1, 0, 0], [1, 0, 0]))
    t.clear('t1', ['camera'])
    expect(t.state('t1').camera).toBe(false)
    expect(t.holds('t1', ['camera'])).toBe(true)
    // Granted again; the old sighting doesn't count for it.
    t.report('t1', doc('top', [1, 0, 0], [0, 0, 0]))
    t.grant('t1', ['camera'])
    expect(t.state('t1').camera).toBe(true)
    t.report('t1', doc('top', [2, 0, 0], [0, 0, 0]))
    expect(t.state('t1').camera).toBe(false)
  })

  it('keeps counts from going backwards within a document', () => {
    const t = new CaptureTracker()
    t.grant('t1', ['camera'])
    t.grant('t1', ['camera'])
    t.report('t1', doc('top', [2, 0, 0], [0, 0, 0]))
    t.report('t1', doc('top', [1, 0, 0], [0, 0, 0]))
    expect(t.state('t1').camera).toBe(false)
  })
})
