/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE } from '@shared/ipc'

// The capture tracker. The tab's camera, microphone and screen
// icons start when Apex grants them; this narrows them to the tracks the
// page still holds, so an ended call clears its icons without a reload. Each
// document, in every frame, gets a small wrapper in the page's own world
// that counts the captures getUserMedia and getDisplayMedia hand out and
// each of their tracks and clones until it ends. It reports through a
// function this isolated world hands it before any page script runs, so a
// page can neither send a report nor stop one; the sharing bar's Stop comes
// back through the function the wrapper returns. Main turns an icon off only
// once every capture it granted was seen here and has ended, and reloads a
// page that ignores Stop (main/capture.ts).

/** "seen;live" counts as camera,microphone,screen: what the page's world sends. */
const COUNTS = /^(\d{1,6}),(\d{1,6}),(\d{1,6});(\d{1,6}),(\d{1,6}),(\d{1,6})$/

/**
 * Runs in the page's own world (serialised by executeInMainWorld), so it uses
 * nothing from outside itself. Everything it calls later is taken now, before
 * any page script runs: a page that patches prototypes afterwards can't blind
 * it. Returns Stop, which ends the tracks of the kinds a "camera, microphone,
 * screen" mask of 1s and 0s names.
 */
export function tracker(report: (counts: string) => void): ((mask: string) => void) | undefined {
  if (typeof MediaStreamTrack !== 'function' || typeof MediaStream !== 'function') return undefined
  const apply = Reflect.apply
  const own = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty
  const hasOwn = Object.prototype.hasOwnProperty
  const TrackProto = MediaStreamTrack.prototype
  const StreamProto = MediaStream.prototype
  const kindOf = own(TrackProto, 'kind')?.get
  const stateOf = own(TrackProto, 'readyState')?.get
  const settingsOf = TrackProto.getSettings
  const stopTrack = TrackProto.stop
  const tracksOf = StreamProto.getTracks
  const listen = EventTarget.prototype.addEventListener
  const then = Promise.prototype.then
  const later = queueMicrotask
  const mapGet = Map.prototype.get
  const mapSet = Map.prototype.set
  const mapDelete = Map.prototype.delete
  const mapEach = Map.prototype.forEach
  if (!kindOf || !stateOf) return undefined

  // Track → 0 camera, 1 microphone, 2 screen. Ended tracks leave.
  const live = new Map<MediaStreamTrack, 0 | 1 | 2>()
  const seen: [number, number, number] = [0, 0, 0]
  let queued = false
  const flush = (): void => {
    queued = false
    const on: [number, number, number] = [0, 0, 0]
    apply(mapEach, live, [
      (kind: 0 | 1 | 2) => {
        on[kind]++
      },
    ])
    report(`${seen[0]},${seen[1]},${seen[2]};${on[0]},${on[1]},${on[2]}`)
  }
  const send = (): void => {
    if (queued) return
    queued = true
    later(flush)
  }
  const end = (track: MediaStreamTrack): void => {
    if (apply(mapDelete, live, [track])) send()
  }
  const add = (track: MediaStreamTrack, kind: 0 | 1 | 2): void => {
    if (apply(mapGet, live, [track]) !== undefined) return
    apply(mapSet, live, [track, kind])
    // A source that ends by itself (unplugged, access withdrawn) fires a trusted 'ended'; a page's own event is ignored.
    apply(listen, track, [
      'ended',
      (event: Event) => {
        if (event.isTrusted) end(track)
      },
    ])
    send()
  }
  /** A clone's kind: its source's, or for a track this world never saw (another frame's), what its settings say. */
  const kindOfClone = (source: MediaStreamTrack, copy: MediaStreamTrack): 0 | 1 | 2 | -1 => {
    const known = apply(mapGet, live, [source])
    if (known !== undefined && apply(kindOf, source, []) === apply(kindOf, copy, [])) return known
    let settings: MediaTrackSettings
    try {
      settings = apply(settingsOf, copy, [])
    } catch {
      return -1
    }
    if (apply(hasOwn, settings, ['displaySurface'])) return 2
    if (!apply(hasOwn, settings, ['deviceId'])) return -1
    return apply(kindOf, copy, []) === 'video' ? 0 : 1
  }
  const adopt = (source: MediaStreamTrack, copy: MediaStreamTrack): void => {
    const kind = kindOfClone(source, copy)
    if (kind !== -1 && apply(stateOf, copy, []) === 'live') add(copy, kind)
  }
  const watch = (stream: MediaStream, screen: boolean): MediaStream => {
    const tracks: MediaStreamTrack[] = apply(tracksOf, stream, [])
    const kinds: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]!
      const kind = screen ? 2 : apply(kindOf, track, []) === 'video' ? 0 : 1
      kinds[kind] = 1
      add(track, kind)
    }
    seen[0] += kinds[0]
    seen[1] += kinds[1]
    seen[2] += kinds[2]
    send()
    return stream
  }
  /** Replaces a prototype method in place, keeping its name, length and attributes. */
  const wrap = (proto: object | undefined, name: string, make: (original: (...args: unknown[]) => unknown) => (this: unknown, ...args: unknown[]) => unknown): void => {
    const desc = proto ? own(proto, name) : undefined
    if (!proto || !desc || typeof desc.value !== 'function') return
    const original = desc.value as (...args: unknown[]) => unknown
    const body = make(original)
    const fn = {
      [name](this: unknown, ...args: unknown[]) {
        return apply(body, this, args)
      },
    }[name]
    define(fn, 'length', { value: original.length, configurable: true })
    define(proto, name, { value: fn, writable: desc.writable, enumerable: desc.enumerable, configurable: desc.configurable })
  }

  const devices = typeof MediaDevices === 'function' ? MediaDevices.prototype : undefined
  for (const [name, screen] of [
    ['getUserMedia', false],
    ['getDisplayMedia', true],
  ] as const) {
    wrap(devices, name, (original) =>
      function (this: unknown, ...args: unknown[]) {
        return apply(then, apply(original, this, args), [(stream: MediaStream) => watch(stream, screen)])
      },
    )
  }
  // The old callback forms reach the same capture.
  const nav = typeof Navigator === 'function' ? Navigator.prototype : undefined
  for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
    wrap(nav, name, (original) =>
      function (this: unknown, constraints: unknown, success: unknown, failure: unknown) {
        const done = typeof success === 'function' ? (stream: MediaStream) => apply(success, undefined, [watch(stream, false)]) : success
        return apply(original, this, [constraints, done, failure])
      },
    )
  }
  wrap(TrackProto, 'stop', (original) =>
    function (this: unknown) {
      apply(original, this, [])
      end(this as MediaStreamTrack)
    },
  )
  // A clone keeps the device on after its source stops, so it counts as a track of its own.
  wrap(TrackProto, 'clone', (original) =>
    function (this: unknown) {
      const copy = apply(original, this, []) as MediaStreamTrack
      adopt(this as MediaStreamTrack, copy)
      return copy
    },
  )
  wrap(StreamProto, 'clone', (original) =>
    function (this: unknown) {
      const copy = apply(original, this, []) as MediaStream
      const from: MediaStreamTrack[] = apply(tracksOf, this, [])
      const to: MediaStreamTrack[] = apply(tracksOf, copy, [])
      for (let i = 0; i < to.length; i++) adopt(from[i] ?? to[i]!, to[i]!)
      return copy
    },
  )

  return (mask: string): void => {
    apply(mapEach, live, [
      (kind: 0 | 1 | 2, track: MediaStreamTrack) => {
        if (mask[kind] !== '1') return
        try {
          apply(stopTrack, track, [])
        } catch {
          // Main reloads a page whose tracks didn't stop.
        }
        apply(mapDelete, live, [track])
      },
    ])
    send()
  }
}

function documentId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function installCapture(): void {
  const doc = documentId()
  let last: number[] | null = null
  const send = (counts: number[], gone: boolean): void => {
    ipcRenderer.send(PAGE.capture, { doc, seen: counts.slice(0, 3), live: gone ? [0, 0, 0] : counts.slice(3), gone })
  }
  // Runs in this isolated world; the page's world holds only a proxy, inside the tracker's closure.
  const report = (counts: unknown): void => {
    const m = typeof counts === 'string' ? COUNTS.exec(counts) : null
    if (!m) return
    last = m.slice(1).map(Number)
    send(last, false)
  }
  let stop: unknown
  try {
    stop = contextBridge.executeInMainWorld({ func: tracker, args: [report] })
  } catch {
    // A world that can't be reached keeps main's own record, which never hides a capture.
    return
  }
  // The document going away ends its tracks; only the browser's own pagehide counts.
  window.addEventListener(
    'pagehide',
    (event) => {
      if (event.isTrusted && last) send(last, true)
    },
    true,
  )
  ipcRenderer.on(PAGE.captureStop, (_event, kinds: unknown) => {
    if (!Array.isArray(kinds) || typeof stop !== 'function') return
    const mask = (['camera', 'microphone', 'screen'] as const).map((k) => (kinds.includes(k) ? '1' : '0')).join('')
    try {
      ;(stop as (mask: string) => void)(mask)
    } catch {
      // Main reloads a page that keeps capturing.
    }
  })
}
