/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The media hub (MD-01 to MD-04): what is playing across a window's tabs, the
// now-playing controls, playback speed and automatic picture-in-picture. Each
// tab's page helper (preload/page/media.ts) reports its media and Media
// Session (title, artist, artwork, the actions the page handles); main's hub
// (main/media/hub.ts) merges that with what Chromium knows (sound, mute) and
// sends each window its sources. The pure rules below pick and order them.

/** The speeds offered (MD-03), from half to triple. */
export const MEDIA_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
export const MEDIA_RATE_MIN = 0.5
export const MEDIA_RATE_MAX = 3

/** Page channels: page → main reports, main → page commands. Validated with zod in main. */
export const PAGE_MEDIA = {
  /** page → main: a PageMediaReport for the sending frame, or null when its media is gone. */
  report: 'atelier-page:media',
  /** main → page: a PageMediaCommand for that frame's helper. */
  command: 'atelier-page:media-command',
} as const

/** Media Session actions the controls can ask a page to run. */
export const MEDIA_SESSION_ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'stop'] as const
export type MediaSessionAction = (typeof MEDIA_SESSION_ACTIONS)[number]

export const MEDIA_TEXT_MAX = 300
export const MEDIA_ARTWORK_MAX = 4096

/** What one frame's page helper sees. */
export interface PageMediaReport {
  /** The lead element (playing with sound first, then playing, then the last one played) is playing. */
  playing: boolean
  /** The lead element is a video with a picture. */
  video: boolean
  /** The lead element plays with its sound on (not muted, volume above zero). */
  sound: boolean
  /** The lead element's playback rate. */
  rate: number
  /** A video of this frame is in picture-in-picture. */
  pip: boolean
  /** The lead video allows picture-in-picture. */
  canPip: boolean
  /** There is something to resume: the lead has started and not ended. */
  resumable: boolean
  /** The page's Media Session metadata ('' when it set none). */
  title: string
  artist: string
  album: string
  /** The best artwork address the page gave (http, https or a small data: image), or null. */
  artwork: string | null
  /** Actions the page handles itself (Media Session handlers). */
  actions: MediaSessionAction[]
}

/** Main → page commands. `context` ones act on the media element the page menu opened on. */
export type PageMediaCommand =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'action'; action: MediaSessionAction }
  | { kind: 'rate'; rate: number }
  | { kind: 'context'; op: 'rate'; rate: number }
  | { kind: 'context'; op: 'loop' | 'controls' }

/** One source in the now-playing control. */
export interface MediaSource {
  tabId: string
  /** The Media Session title, else the tab's title. */
  title: string
  /** The Media Session artist (or album); '' without one. */
  artist: string
  /** The page's host, without www. */
  site: string
  favicon: string | null
  artwork: string | null
  playing: boolean
  /** The tab is muted. */
  muted: boolean
  video: boolean
  rate: number
  pip: boolean
  canPip: boolean
  canPrevious: boolean
  canNext: boolean
  /** Showing now in its window (the active tab, or a pane of the active split). */
  visible: boolean
  /** In another window of the same profile. */
  elsewhere: boolean
  /** Media keys and the system's Now Playing follow this one: Chromium gives audio focus to the source that started last. */
  active: boolean
}

export interface MediaHubState {
  /** Playing ones first, newest first; then paused ones. */
  sources: MediaSource[]
  /** The sidebar card's source (SH-17): the first that isn't showing, or null. */
  cardId: string | null
}

export const EMPTY_MEDIA_STATE: MediaHubState = { sources: [], cardId: null }

export type MediaCommand = 'play' | 'pause' | 'previous' | 'next' | 'mute' | 'unmute' | 'dismiss'
export const MEDIA_COMMANDS = ['play', 'pause', 'previous', 'next', 'mute', 'unmute', 'dismiss'] as const satisfies readonly MediaCommand[]

// ── selection ──

/** A tab as the hub sees it. */
export interface MediaTabInput {
  id: string
  title: string
  url: string
  favicon: string | null
  /** Chromium hears sound from the tab now. */
  audible: boolean
  muted: boolean
  visible: boolean
  elsewhere: boolean
  report: PageMediaReport | null
}

export interface MediaMemory {
  /** Tabs in the order they last started playing, newest last. */
  started: readonly string[]
  /** Dismissed tabs stay hidden until they go quiet and play again. */
  dismissed: ReadonlySet<string>
  /** Tabs listed while they played; they stay listed, paused, while they can resume. */
  known: ReadonlySet<string>
  /** The tab Atelier's controls paused last; it stays listed so it can resume. */
  held: string | null
}

export const EMPTY_MEDIA_MEMORY: MediaMemory = { started: [], dismissed: new Set(), known: new Set(), held: null }

/** Playing in a way worth a control: with sound (even in a muted tab), or with a Media Session. Muted autoplay isn't. */
export function playsForReal(tab: MediaTabInput): boolean {
  const r = tab.report
  return tab.audible || (r !== null && r.playing && (r.sound || r.title !== ''))
}

/** Whether the tab is a source now. */
export function isSource(tab: MediaTabInput, memory: MediaMemory): boolean {
  if (memory.dismissed.has(tab.id)) return false
  if (playsForReal(tab)) return true
  const r = tab.report
  if (memory.held === tab.id) return true
  return memory.known.has(tab.id) && r !== null && (r.resumable || r.title !== '')
}

/**
 * The memory after a look at every tab: tabs that start playing move to the
 * end of `started`, a tab that plays again leaves `held`, a dismissed tab that
 * goes quiet is forgotten (so it shows again when it next plays), and closed
 * tabs drop out. `wasPlaying` is the last look's answer per tab; the second
 * value is this one's.
 */
export function observeMedia(memory: MediaMemory, wasPlaying: ReadonlyMap<string, boolean>, tabs: readonly MediaTabInput[]): [MediaMemory, Map<string, boolean>] {
  const ids = new Set(tabs.map((t) => t.id))
  const playing = new Map<string, boolean>()
  let started = memory.started.filter((id) => ids.has(id))
  const dismissed = new Set([...memory.dismissed].filter((id) => ids.has(id)))
  const known = new Set([...memory.known].filter((id) => ids.has(id)))
  let held = memory.held && ids.has(memory.held) ? memory.held : null
  for (const tab of tabs) {
    const now = playsForReal(tab)
    const before = wasPlaying.get(tab.id) ?? false
    playing.set(tab.id, now)
    if (now && !before) {
      started = [...started.filter((id) => id !== tab.id), tab.id]
      if (held === tab.id) held = null
    }
    if (!now && before && dismissed.has(tab.id) && held !== tab.id) {
      dismissed.delete(tab.id)
      known.delete(tab.id)
    }
    if (now && !dismissed.has(tab.id)) known.add(tab.id)
    // Nothing left to resume (navigated away, the media removed): it leaves the list.
    if (!now && known.has(tab.id) && held !== tab.id && !(tab.report && (tab.report.resumable || tab.report.title !== ''))) known.delete(tab.id)
  }
  return [{ started, dismissed, known, held }, playing]
}

export function siteOf(url: string): string {
  try {
    const u = new URL(url)
    return (u.hostname || u.protocol.replace(/:$/, '')).replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The window's sources, playing first, newest first; `active` marks the newest one, as Chromium's audio focus does. */
export function mediaSources(tabs: readonly MediaTabInput[], memory: MediaMemory): MediaSource[] {
  const rank = (id: string): number => memory.started.indexOf(id)
  const listed = tabs.filter((t) => isSource(t, memory))
  const playing = new Set(listed.filter(playsForReal).map((t) => t.id))
  listed.sort((a, b) => Number(playing.has(b.id)) - Number(playing.has(a.id)) || rank(b.id) - rank(a.id))
  const newest = listed.reduce<MediaTabInput | null>((best, t) => (best === null || rank(t.id) > rank(best.id) ? t : best), null)
  return listed.map((t) => {
    const r = t.report
    const can = (a: MediaSessionAction): boolean => r?.actions.includes(a) ?? false
    return {
      tabId: t.id,
      title: r?.title || t.title || siteOf(t.url),
      artist: r?.artist || r?.album || '',
      site: siteOf(t.url),
      favicon: t.favicon,
      artwork: r?.artwork ?? null,
      playing: playing.has(t.id),
      muted: t.muted,
      video: r?.video ?? false,
      rate: r?.rate ?? 1,
      pip: r?.pip ?? false,
      canPip: r?.canPip ?? false,
      canPrevious: can('previoustrack'),
      canNext: can('nexttrack'),
      visible: t.visible,
      elsewhere: t.elsewhere,
      active: newest?.id === t.id,
    }
  })
}

/** The sidebar card's source: the first one in this window that isn't showing. */
export function cardSource(sources: readonly MediaSource[]): string | null {
  return sources.find((s) => !s.visible && !s.elsewhere)?.tabId ?? null
}

export function mediaHubState(tabs: readonly MediaTabInput[], memory: MediaMemory): MediaHubState {
  const sources = mediaSources(tabs, memory)
  return { sources, cardId: cardSource(sources) }
}

// ── speed ──

/** A speed within 0.5–3×, to two decimals; anything else is 1. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1
  return Math.round(Math.min(MEDIA_RATE_MAX, Math.max(MEDIA_RATE_MIN, rate)) * 100) / 100
}

/** The offered speed closest to `rate`, for marking the current one. */
export function nearestRate(rate: number): (typeof MEDIA_RATES)[number] {
  let best: (typeof MEDIA_RATES)[number] = 1
  for (const r of MEDIA_RATES) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r
  return best
}

/** "1.5×" in the locale's digits. */
export function rateLabel(rate: number, locale?: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(rate)}×`
}

// ── automatic picture-in-picture (ST-29, MD-02) ──

export interface AutoPipInput {
  enabled: boolean
  /** Chromium hears the tab now. */
  audible: boolean
  /** The tab is muted. */
  tabMuted: boolean
  agentControlled: boolean
  chromeDrawn: boolean
  /** The page helper's report for the tab's lead frame, when it has one. */
  report: PageMediaReport | null
}

/**
 * Leaving the tab moves its video into picture-in-picture when a video plays
 * with sound. The page's report decides when there is one (a quiet passage
 * still counts; audio alone, muted autoplay or a page that forbids it don't);
 * without one, Chromium hearing the tab does, and the page script still
 * looks for such a video. Never for an agent's tab or a page Atelier draws.
 */
export function autoPipEligible(input: AutoPipInput): boolean {
  if (!input.enabled || input.agentControlled || input.chromeDrawn || input.tabMuted) return false
  const r = input.report
  if (r) return r.playing && r.video && r.sound && r.canPip && !r.pip
  return input.audible
}

// ── artwork ──

/** Parses a Media Session sizes list ("96x96 128x128", "any"): the largest side, Infinity for any, 0 when unknown. */
function largestSide(sizes: string): number {
  let best = 0
  for (const part of sizes.toLowerCase().split(/\s+/)) {
    if (part === 'any') return Number.POSITIVE_INFINITY
    const m = /^(\d+)x(\d+)$/.exec(part)
    if (m) best = Math.max(best, Math.min(Number(m[1]), Number(m[2])))
  }
  return best
}

/** Artwork Atelier may draw: http(s), or a data: image small enough to send around. */
export function usableArtwork(src: string): boolean {
  if (src.length > MEDIA_ARTWORK_MAX) return false
  return /^https?:\/\//i.test(src) || /^data:image\/(png|jpeg|webp|gif|avif);/i.test(src)
}

/** The artwork to show at about 64 px: the smallest that is at least 96 px, else the largest; null when none is usable. */
export function pickArtwork(images: readonly { src: string; sizes: string }[]): string | null {
  const usable = images.filter((i) => usableArtwork(i.src))
  if (usable.length === 0) return null
  const sized = usable.map((i) => ({ src: i.src, side: largestSide(i.sizes) }))
  const big = sized.filter((i) => i.side >= 96).sort((a, b) => a.side - b.side)
  if (big.length) return big[0]!.src
  return sized.sort((a, b) => b.side - a.side)[0]!.src
}

// ── service and event ──

/** The `media` namespace (window-scoped: each window's chrome and overlays see their own sources). */
export interface MediaServices {
  media: {
    state(): MediaHubState
    control(tabId: string, command: MediaCommand): Promise<void>
    /** MD-03: 0.5–3×, on what plays in that tab. */
    setRate(tabId: string, rate: number): Promise<void>
    /** Moves the tab's video into picture-in-picture, or back; true when it is in now. */
    pictureInPicture(tabId: string): Promise<boolean>
    /** Goes to the tab, in whichever window holds it. */
    focus(tabId: string): void
  }
}

export type MediaEvent = { type: 'media'; state: MediaHubState }

// ── the page world's Media Session report ──

/** What the page's own world says about its Media Session (preload/page/media.ts). */
export interface SessionInfo {
  actions: MediaSessionAction[]
  title: string
  artist: string
  album: string
  artwork: string | null
}

export const NO_SESSION: SessionInfo = { actions: [], title: '', artist: '', album: '', artwork: null }

function sessionText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MEDIA_TEXT_MAX) : ''
}

/** The page world's JSON, checked: a page can only describe its own media with it. */
export function parseSessionDetail(detail: unknown): SessionInfo {
  if (typeof detail !== 'string' || detail.length > 200_000) return NO_SESSION
  try {
    const raw = JSON.parse(detail) as Record<string, unknown>
    if (!raw || typeof raw !== 'object') return NO_SESSION
    const listed = Array.isArray(raw.actions) ? (raw.actions as unknown[]) : []
    const actions = MEDIA_SESSION_ACTIONS.filter((a) => listed.includes(a))
    const images = Array.isArray(raw.artwork)
      ? (raw.artwork as unknown[]).flatMap((a) => {
          const o = a && typeof a === 'object' ? (a as Record<string, unknown>) : null
          return o && typeof o.src === 'string' ? [{ src: o.src, sizes: typeof o.sizes === 'string' ? o.sizes : '' }] : []
        })
      : []
    return { actions, title: sessionText(raw.title), artist: sessionText(raw.artist), album: sessionText(raw.album), artwork: pickArtwork(images) }
  } catch {
    return NO_SESSION
  }
}
