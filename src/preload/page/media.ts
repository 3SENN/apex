/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { NO_SESSION, PAGE_MEDIA, clampRate, parseSessionDetail, type MediaSessionAction, type PageMediaCommand, type PageMediaReport } from '@shared/media'

// The page media helper (MD-01 to MD-03), in every frame of a tab. Here, in
// Electron's isolated world, it watches the frame's audio and video elements
// (their events reach a capture listener on the document) and reports the
// lead one to main, with the page's Media Session: what it says is playing
// and which actions it handles. Main's commands come back here: play, pause,
// the page's own previous and next, and playback speed. Media Session handlers
// live in the page's own world, so a small wrapper there (`sessionWorld`)
// remembers them, reports the metadata and runs a handler when asked, by
// events whose detail is a string (a string crosses worlds intact). Nothing
// is reported until the frame has media, and no part goes in on sign-in pages.

const SESSION = 'apex-media-session'
const ASK = 'apex-media-ask'
const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'ratechange', 'volumechange', 'loadedmetadata', 'emptied', 'enterpictureinpicture', 'leavepictureinpicture'] as const
/** While something plays, the metadata is read again this often (a page may change it in place). */
const POLL_MS = 4000
const REPORT_DELAY_MS = 120

/** Runs in the page's own world (serialised by executeInMainWorld): uses nothing from outside itself. */
function sessionWorld(sessionEvent: string, askEvent: string): void {
  type Bag = Record<string, any>
  const ms = navigator.mediaSession as MediaSession | undefined
  if (!ms) return
  const proto = Object.getPrototypeOf(ms) as Bag
  const apply = Reflect.apply
  const defineProperty = Object.defineProperty
  const getDescriptor = Object.getOwnPropertyDescriptor
  const dispatch = EventTarget.prototype.dispatchEvent
  const Custom = CustomEvent
  const stringify = JSON.stringify
  const handlers = new Map<string, (details: { action: string }) => void>()
  // The chrome surface's registry (preload/chromeSurfaceWorld.ts) makes wrappers read as native code.
  let natives: WeakMap<object, string> | null = null
  try {
    const found = apply(Function.prototype.toString, Symbol.for('v8.function.source'), []) as unknown
    if (found && typeof found === 'object' && (found as Bag).natives instanceof WeakMap) natives = (found as Bag).natives as WeakMap<object, string>
  } catch {
    natives = null
  }
  const wmSet = WeakMap.prototype.set
  const native = (fn: object, text: string): void => {
    if (natives) apply(wmSet, natives, [fn, text])
  }

  const report = (): void => {
    let title = ''
    let artist = ''
    let album = ''
    const artwork: { src: string; sizes: string }[] = []
    try {
      const md = ms.metadata
      if (md) {
        title = String(md.title ?? '')
        artist = String(md.artist ?? '')
        album = String(md.album ?? '')
        for (const a of Array.from(md.artwork ?? []).slice(0, 12)) artwork.push({ src: String(a.src ?? ''), sizes: String(a.sizes ?? '') })
      }
    } catch {
      // A page that broke its own metadata reports none.
    }
    const detail = stringify({ actions: Array.from(handlers.keys()), title, artist, album, artwork })
    apply(dispatch, window, [new Custom(sessionEvent, { detail })])
  }

  const set = getDescriptor(proto, 'setActionHandler')
  const original = set?.value as ((...args: unknown[]) => unknown) | undefined
  if (set && typeof original === 'function') {
    const wrapped = {
      setActionHandler(this: unknown, action: unknown, handler: unknown): unknown {
        // eslint-disable-next-line prefer-rest-params
        const out = apply(original, this, arguments as unknown as unknown[])
        if (this === ms) {
          const name = String(action)
          if (typeof handler === 'function') handlers.set(name, handler as (details: { action: string }) => void)
          else handlers.delete(name)
          report()
        }
        return out
      },
    }.setActionHandler
    native(wrapped, 'function setActionHandler() { [native code] }')
    defineProperty(proto, 'setActionHandler', { ...set, value: wrapped })
  }
  for (const key of ['metadata', 'playbackState']) {
    const desc = getDescriptor(proto, key)
    const setter = desc?.set
    if (!desc || typeof setter !== 'function' || !desc.configurable) continue
    const next = getDescriptor(
      {
        set [key](value: unknown) {
          apply(setter, this, [value])
          if ((this as unknown) === ms) report()
        },
      },
      key,
    )?.set
    if (!next) continue
    native(next, `function set ${key}() { [native code] }`)
    defineProperty(proto, key, { ...desc, set: next })
  }
  window.addEventListener(askEvent, (event) => {
    const name = String((event as CustomEvent).detail ?? '')
    if (!name) return report()
    const handler = handlers.get(name)
    if (!handler) return
    try {
      apply(handler, ms, [{ action: name }])
    } catch {
      // The page's own handler failed; nothing to undo.
    }
  })
}

function isPlaying(m: HTMLMediaElement): boolean {
  return !m.paused && !m.ended
}

function hasSound(m: HTMLMediaElement): boolean {
  return !m.muted && m.volume > 0
}

export function installMedia({ mainWorld }: { mainWorld: boolean }): void {
  let session = NO_SESSION
  let seen = false
  let lead: HTMLMediaElement | null = null
  /** What Apex paused (without a page handler), so Play resumes exactly those. */
  let held: HTMLMediaElement[] = []
  /** The media element the page menu opened on. */
  let menuTarget: HTMLMediaElement | null = null
  let last = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null

  const elements = (): HTMLMediaElement[] => Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))

  const pickLead = (): HTMLMediaElement | null => {
    const all = elements()
    const playing = all.filter(isPlaying)
    if (lead && lead.isConnected && isPlaying(lead) && hasSound(lead)) return lead
    const best = playing.find(hasSound) ?? (lead && lead.isConnected && isPlaying(lead) ? lead : null) ?? playing[0]
    if (best) return best
    if (lead && lead.isConnected) return lead
    return all.find((m) => m.currentTime > 0 && !m.ended) ?? null
  }

  const compute = (): PageMediaReport => {
    const m = pickLead()
    const video = m instanceof HTMLVideoElement && m.videoWidth > 0
    return {
      playing: m !== null && isPlaying(m),
      video,
      sound: m !== null && hasSound(m),
      rate: m ? clampRate(m.playbackRate) : 1,
      pip: document.pictureInPictureElement != null,
      canPip: video && document.pictureInPictureEnabled === true && !(m as HTMLVideoElement).disablePictureInPicture,
      resumable: m !== null && m.currentTime > 0 && !m.ended,
      title: session.title,
      artist: session.artist,
      album: session.album,
      artwork: session.artwork,
      actions: session.actions,
    }
  }

  const send = (): void => {
    timer = null
    if (!seen) return
    const report = compute()
    const json = JSON.stringify(report)
    if (json !== last) {
      last = json
      ipcRenderer.send(PAGE_MEDIA.report, report)
    }
    // While something plays, look again now and then: metadata can change in place.
    if (report.playing && !poll) poll = setInterval(() => (ask(''), schedule()), POLL_MS)
    if (!report.playing && poll) {
      clearInterval(poll)
      poll = null
    }
  }
  const schedule = (): void => {
    if (!timer) timer = setTimeout(send, REPORT_DELAY_MS)
  }
  const ask = (action: string): void => {
    if (mainWorld) window.dispatchEvent(new CustomEvent(ASK, { detail: action }))
  }

  if (mainWorld) {
    window.addEventListener(SESSION, (event) => {
      session = parseSessionDetail((event as CustomEvent).detail)
      if (session.title || session.actions.length) seen = true
      schedule()
    })
    try {
      contextBridge.executeInMainWorld({ func: sessionWorld, args: [SESSION, ASK] })
    } catch {
      // Without the page world, the controls still see the elements; next and previous stay hidden.
    }
  }

  for (const type of MEDIA_EVENTS) {
    document.addEventListener(
      type,
      (event) => {
        const el = event.target
        if (!(el instanceof HTMLMediaElement)) return
        if (type === 'play' || type === 'playing' || !lead) lead = el
        if (type === 'play') held = []
        seen = true
        ask('')
        schedule()
      },
      true,
    )
  }
  document.addEventListener(
    'contextmenu',
    (event) => {
      menuTarget = (event.composedPath().find((n) => n instanceof HTMLMediaElement) as HTMLMediaElement | undefined) ?? null
    },
    true,
  )
  window.addEventListener('pagehide', () => {
    if (seen) ipcRenderer.send(PAGE_MEDIA.report, null)
    seen = false
    last = ''
  })

  const has = (a: MediaSessionAction): boolean => mainWorld && session.actions.includes(a)

  ipcRenderer.on(PAGE_MEDIA.command, (_event, raw: unknown) => {
    const command = raw as PageMediaCommand | null
    if (!command || typeof command !== 'object') return
    switch (command.kind) {
      case 'play': {
        if (has('play')) return ask('play')
        const targets = held.filter((m) => m.isConnected)
        held = []
        const list = targets.length ? targets : [pickLead()].filter((m): m is HTMLMediaElement => m !== null)
        for (const m of list) void m.play().catch(() => undefined)
        return
      }
      case 'pause': {
        if (has('pause')) return ask('pause')
        const playing = elements().filter(isPlaying)
        for (const m of playing) m.pause()
        held = playing
        return
      }
      case 'action': {
        if (has(command.action)) return ask(command.action)
        const m = pickLead()
        if (!m) return
        if (command.action === 'seekbackward') m.currentTime = Math.max(0, m.currentTime - 10)
        else if (command.action === 'seekforward') m.currentTime = Math.min(Number.isFinite(m.duration) ? m.duration : m.currentTime + 10, m.currentTime + 10)
        return
      }
      case 'rate': {
        const rate = clampRate(command.rate)
        const playing = elements().filter(isPlaying)
        const list = playing.length ? playing : [pickLead()].filter((m): m is HTMLMediaElement => m !== null)
        for (const m of list) m.playbackRate = rate
        return
      }
      case 'context': {
        const m = menuTarget && menuTarget.isConnected ? menuTarget : null
        if (!m) return
        if (command.op === 'rate') m.playbackRate = clampRate(command.rate)
        else if (command.op === 'loop') m.loop = !m.loop
        else if (command.op === 'controls') m.controls = !m.controls
        return
      }
    }
  })
}
