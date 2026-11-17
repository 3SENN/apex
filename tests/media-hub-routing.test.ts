/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

// MD-01: the hub's routing with fake windows and frames: the lead frame gets
// the commands, the media card's scripts stand in without a report, each
// window hears only changes, and other windows count only on the same session.

const frames = new Map<string, { processId: number; routingId: number; sent: unknown[]; isDestroyed(): boolean; send(channel: string, cmd: unknown): void; executeJavaScript(): Promise<unknown> }>()
vi.mock('electron', () => ({
  webFrameMain: { fromId: (p: number, r: number) => frames.get(`${p}:${r}`) ?? null },
}))

import { PAGE_MEDIA, type PageMediaReport } from '@shared/media'
import { MediaHub } from '../src/main/media/hub'
import { pageMediaMessageSchema } from '../src/main/media/report'
import { PAUSE_SCRIPT } from '../src/main/mediaSessions'

function frame(processId: number, routingId: number) {
  const f = {
    processId,
    routingId,
    sent: [] as unknown[],
    isDestroyed: () => false,
    send(channel: string, cmd: unknown) {
      expect(channel).toBe(PAGE_MEDIA.command)
      f.sent.push(cmd)
    },
    executeJavaScript: async () => true,
  }
  frames.set(`${processId}:${routingId}`, f)
  return f
}

const report = (over: Partial<PageMediaReport> = {}): PageMediaReport => ({ playing: true, video: true, sound: true, rate: 1, pip: false, canPip: true, resumable: true, title: '', artist: '', album: '', artwork: null, actions: [], ...over })

function fakeWindow(id: number, session: object, tabIds: string[], activeId: string | null) {
  const scripts: string[] = []
  const events: unknown[] = []
  const muted = new Map<string, boolean>()
  const tabs = tabIds.map((tid) => ({
    id: tid,
    view: {
      webContents: {
        isDestroyed: () => false,
        mainFrame: { processId: 1, routingId: 1 },
        executeJavaScriptInIsolatedWorld: async (_world: number, [s]: { code: string }[]) => {
          scripts.push(s!.code)
          return 1
        },
      },
    },
  }))
  let active = activeId
  const win = {
    id,
    session,
    events,
    scripts,
    window: { isDestroyed: () => false, isMinimized: () => false, focus: vi.fn(), restore: vi.fn() },
    chrome: { isDestroyed: () => false },
    send: (e: unknown) => events.push(e),
    overlay: { relay: vi.fn() },
    tabs: {
      all: () => tabs,
      find: (tid: string) => tabs.find((t) => t.id === tid),
      visibleIds: () => (active ? [active] : []),
      info: (t: { id: string }) => ({ title: `Title ${t.id}`, url: `https://${t.id}.example/`, favicon: null, audible: false, muted: muted.get(t.id) ?? false }),
      setMuted: (tid: string, m: boolean) => muted.set(tid, m),
      activate: (tid: string) => {
        active = tid
      },
    },
  }
  return win
}

describe('media hub routing', () => {
  it('sends commands to the frame that started playing last', async () => {
    const session = {}
    const win = fakeWindow(1, session, ['t1'], null)
    const hub = new MediaHub({ windows: () => [win as never] })
    const top = frame(1, 1)
    const embed = frame(2, 7)
    hub.report('t1', top, report({ playing: false }))
    hub.report('t1', embed, report({ actions: ['nexttrack'] }))
    hub.flush()
    await hub.control('t1', 'next')
    expect(embed.sent).toEqual([{ kind: 'action', action: 'nexttrack' }])
    await hub.setRate('t1', 9)
    expect(embed.sent.at(-1)).toEqual({ kind: 'rate', rate: 3 })
    expect(top.sent).toEqual([])
    // The embed's page went away: the top frame leads again.
    hub.report('t1', embed, null)
    await hub.control('t1', 'play')
    expect(top.sent).toEqual([{ kind: 'play' }])
    hub.dispose()
  })

  it('falls back to the card scripts without a report, and keeps a paused tab listed', async () => {
    const win = fakeWindow(1, {}, ['t1', 't2'], 't2')
    const hub = new MediaHub({ windows: () => [win as never] })
    hub.report('t1', frame(5, 1), report())
    hub.flush()
    hub.forget('t1')
    await hub.control('t1', 'pause')
    expect(win.scripts).toEqual([PAUSE_SCRIPT])
    hub.flush()
    const state = hub.state(win as never)
    expect(state.sources.map((s) => [s.tabId, s.playing])).toEqual([['t1', false]])
    expect(state.cardId).toBe('t1')
    await hub.control('t1', 'mute')
    hub.flush()
    expect(hub.state(win as never).sources[0]!.muted).toBe(true)
    await hub.control('t1', 'dismiss')
    hub.flush()
    expect(hub.state(win as never).sources).toEqual([])
    hub.dispose()
  })

  it('tells a window only when its sources change, and lists same-session windows', () => {
    const shared = {}
    const a = fakeWindow(1, shared, ['a1'], 'a1')
    const b = fakeWindow(2, shared, ['b1'], null)
    const priv = fakeWindow(3, {}, ['p1'], null)
    const hub = new MediaHub({ windows: () => [a, b, priv] as never })
    hub.report('b1', frame(9, 1), report({ title: 'Song' }))
    hub.report('p1', frame(9, 2), report({ title: 'Secret' }))
    hub.flush()
    hub.flush()
    expect(a.events).toHaveLength(1)
    const sources = (a.events[0] as { state: { sources: { tabId: string; elsewhere: boolean }[] } }).state.sources
    expect(sources.map((s) => [s.tabId, s.elsewhere])).toEqual([['b1', true]])
    expect(priv.events).toHaveLength(1)
    hub.focus('b1')
    expect(b.window.focus).toHaveBeenCalled()
    hub.dispose()
  })
})

describe('page media reports', () => {
  it('accepts a report and clamps its speed; rejects artwork Atelier would not draw', () => {
    expect(pageMediaMessageSchema.parse(report({ rate: 8 }))).toMatchObject({ rate: 3 })
    expect(pageMediaMessageSchema.parse(null)).toBeNull()
    expect(pageMediaMessageSchema.safeParse(report({ artwork: 'javascript:alert(1)' })).success).toBe(false)
    expect(pageMediaMessageSchema.safeParse({ ...report(), extra: 1 }).success).toBe(false)
    expect(pageMediaMessageSchema.safeParse(report({ actions: ['seekto' as never] })).success).toBe(false)
  })
})
