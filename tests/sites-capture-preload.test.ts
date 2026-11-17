/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The page tracker (preload/page/capture.ts): what it counts, and that a
// page can neither forge its reports nor blind it after it installs.

const h = vi.hoisted(() => ({
  sent: [] as { channel: string; payload: unknown }[],
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
}))

vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: ({ func, args }: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => func(...(args ?? [])) },
  ipcRenderer: {
    send: (channel: string, payload: unknown) => h.sent.push({ channel, payload }),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => h.listeners.set(channel, fn),
  },
}))

import { PAGE } from '@shared/ipc'
import { installCapture, tracker } from '../src/preload/page/capture'

/** Stand-ins for the page's media classes; fresh ones each test, since the tracker wraps their prototypes. */
function media() {
  const rawClone = (t: Track): Track => {
    const c = new Track(t.kind, t.settings)
    if (t.readyState === 'ended') c.stop()
    return c
  }
  class Track extends EventTarget {
    #kind: string
    #state = 'live'
    settings: Record<string, string>
    constructor(kind: string, settings: Record<string, string> = { deviceId: `${kind}-1` }) {
      super()
      this.#kind = kind
      this.settings = settings
    }
    get kind(): string {
      return this.#kind
    }
    get readyState(): string {
      return this.#state
    }
    getSettings(): Record<string, string> {
      return { ...this.settings }
    }
    stop(): void {
      this.#state = 'ended'
    }
    clone(): Track {
      return rawClone(this)
    }
  }
  class Stream {
    #tracks: Track[]
    constructor(tracks: Track[]) {
      this.#tracks = tracks
    }
    getTracks(): Track[] {
      return [...this.#tracks]
    }
    // A stream's clone copies its tracks inside the engine, past any wrapper on Track.clone.
    clone(): Stream {
      return new Stream(this.#tracks.map(rawClone))
    }
  }
  class Devices {
    getUserMedia(c: { video?: boolean; audio?: boolean } = {}): Promise<Stream> {
      return Promise.resolve(new Stream([...(c.video ? [new Track('video')] : []), ...(c.audio ? [new Track('audio')] : [])]))
    }
    getDisplayMedia(): Promise<Stream> {
      return Promise.resolve(new Stream([new Track('video', { displaySurface: 'monitor' })]))
    }
  }
  class Nav {
    webkitGetUserMedia(c: { video?: boolean }, ok: (s: Stream) => void): void {
      setTimeout(() => ok(new Stream(c.video ? [new Track('video')] : [])), 0)
    }
  }
  vi.stubGlobal('MediaStreamTrack', Track)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('MediaDevices', Devices)
  vi.stubGlobal('Navigator', Nav)
  return { Track, Stream, Devices, Nav, devices: new Devices() }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let reports: string[]
let stop: (mask: string) => void
beforeEach(() => {
  reports = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  h.sent.length = 0
  h.listeners.clear()
})

function install(): ReturnType<typeof media> {
  const m = media()
  stop = tracker((counts) => reports.push(counts))!
  return m
}

describe('the page capture tracker', () => {
  it('counts each capture as seen, and its tracks as live until they stop', async () => {
    const { devices } = install()
    const stream = await devices.getUserMedia({ video: true, audio: true })
    await settle()
    expect(reports.at(-1)).toBe('1,1,0;1,1,0')
    stream.getTracks()[0]!.stop()
    await settle()
    expect(reports.at(-1)).toBe('1,1,0;0,1,0')
  })

  it('counts screen sharing, and the old callback form of getUserMedia', async () => {
    const { devices, Nav } = install()
    await devices.getDisplayMedia()
    await new Promise<void>((done) => new Nav().webkitGetUserMedia({ video: true }, () => done()))
    await settle()
    expect(reports.at(-1)).toBe('1,0,1;1,0,1')
  })

  it('keeps a clone live after its source stops, for track and stream clones alike', async () => {
    const { devices } = install()
    const stream = await devices.getUserMedia({ video: true })
    const [camera] = stream.getTracks()
    const copy = camera!.clone()
    const streamCopy = stream.clone()
    camera!.stop()
    copy.stop()
    await settle()
    expect(reports.at(-1)).toBe('1,0,0;1,0,0')
    streamCopy.getTracks()[0]!.stop()
    await settle()
    expect(reports.at(-1)).toBe('1,0,0;0,0,0')
  })

  it("counts a clone of a camera track it never saw (from another frame's realm)", async () => {
    const { Track } = install()
    const foreign = new Track('video')
    foreign.clone()
    await settle()
    expect(reports.at(-1)).toBe('0,0,0;1,0,0')
    // A canvas or remote track has no device behind it.
    new Track('video', {}).clone()
    await settle()
    expect(reports.at(-1)).toBe('0,0,0;1,0,0')
  })

  it("ignores a page's own 'ended' event and later prototype patches", async () => {
    const { devices, Track, Stream, Devices } = install()
    const stream = await devices.getUserMedia({ video: true })
    stream.getTracks()[0]!.dispatchEvent(new Event('ended'))
    Object.defineProperty(Track.prototype, 'readyState', { get: () => 'ended', configurable: true })
    Object.defineProperty(Track.prototype, 'kind', { get: () => 'audio', configurable: true })
    Stream.prototype.getTracks = () => []
    await Devices.prototype.getUserMedia.call(devices, { video: true })
    await settle()
    expect(reports.at(-1)).toBe('2,0,0;2,0,0')
  })

  it('stops the kinds Stop names and nothing else', async () => {
    const { devices } = install()
    const stream = await devices.getUserMedia({ video: true, audio: true })
    stop('100')
    await settle()
    expect(reports.at(-1)).toBe('1,1,0;0,1,0')
    expect(stream.getTracks().map((t) => t.readyState)).toEqual(['ended', 'live'])
  })
})

describe('the isolated half', () => {
  it("reports only what the page's world sends through its closure; page events forge nothing", async () => {
    const page = new EventTarget()
    vi.stubGlobal('window', page)
    const { devices } = media()
    installCapture()
    // The old channel, and a fake pagehide: neither reaches main.
    page.dispatchEvent(new CustomEvent('apex-capture-report', { detail: '000' }))
    page.dispatchEvent(new Event('pagehide'))
    expect(h.sent).toEqual([])
    await devices.getUserMedia({ audio: true })
    await settle()
    expect(h.sent).toHaveLength(1)
    const sent = h.sent[0]!
    expect(sent.channel).toBe(PAGE.capture)
    expect(sent.payload).toMatchObject({ seen: [0, 1, 0], live: [0, 1, 0], gone: false })
    expect((sent.payload as { doc: string }).doc).toMatch(/^[0-9a-f]{24}$/)
  })

  it("hands main's Stop to the page's world as a mask", async () => {
    vi.stubGlobal('window', new EventTarget())
    const { devices } = media()
    installCapture()
    const stream = await devices.getUserMedia({ video: true, audio: true })
    h.listeners.get(PAGE.captureStop)?.({}, ['microphone', 'bogus'])
    expect(stream.getTracks().map((t) => t.readyState)).toEqual(['live', 'ended'])
  })
})
