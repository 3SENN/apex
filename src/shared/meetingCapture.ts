/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Meeting capture: detecting meeting sites, the meeting card, the
// recorder and the recording widget with its wrap-up.
import type { DesktopCallAppId } from './desktopCalls'
import type { AudioOnlyReason } from './meetings'
import type { SpeechErrorCode, PermissionKind, SpeechPermissions } from './speech'

export type MeetingProvider = 'meet' | 'zoom' | 'teams' | 'webex' | 'whereby' | 'jitsi'

export const MEETING_PROVIDERS: readonly MeetingProvider[] = ['meet', 'zoom', 'teams', 'webex', 'whereby', 'jitsi']

/** The services' own names: proper nouns, so they are not translated. */
export const PROVIDER_NAMES: Record<MeetingProvider, string> = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Microsoft Teams',
  webex: 'Webex',
  whereby: 'Whereby',
  jitsi: 'Jitsi Meet',
}

export interface DetectedMeeting {
  provider: MeetingProvider
  /** Stable per meeting, so each meeting triggers the card once. */
  key: string
  title: string
}

export interface DetectOptions {
  /** ATELIER_SMOKE: also accept the fixture pattern <base>/meet/<code> on 127.0.0.1 or localhost. */
  smoke?: boolean
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/
const ZOOM_ID = /^\d{9,13}$/
// Whereby and Jitsi rooms sit at the top level, next to the services' own pages.
const WHEREBY_RESERVED = new Set([
  'about', 'api', 'blog', 'business', 'careers', 'contact', 'customers', 'developers', 'download', 'embed', 'enterprise', 'features',
  'help', 'information', 'integrations', 'legal', 'login', 'org', 'partners', 'pricing', 'privacy', 'products', 'resources', 'security',
  'signup', 'solutions', 'support', 'terms', 'use-cases', 'user',
])
const WHEREBY_SUBDOMAINS = new Set(['www', 'docs', 'api', 'help', 'blog', 'status', 'embed', 'dev', 'support'])
const JITSI_RESERVED = new Set(['static', 'libs', 'css', 'images', 'fonts', 'sounds', 'lang', 'connection_optimization', 'close', 'http-bind', 'xmpp-websocket'])
const ROOM = /^[a-z0-9][a-z0-9._-]{0,99}$/i

const isHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

function found(provider: MeetingProvider, key: string): DetectedMeeting {
  return { provider, key: `${provider}:${key}`, title: PROVIDER_NAMES[provider] }
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/**
 * A meeting URL's provider and key, or null. Matches the meeting itself
 * (a Meet code, a Zoom web-client or join link, a Teams meetup link, a Webex
 * room or join link, a Whereby or Jitsi room), never a landing or home page.
 */
export function detectMeeting(url: string, options: DetectOptions = {}): DetectedMeeting | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  const segs = u.pathname.split('/').filter(Boolean)
  if (options.smoke && u.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
    const code = segs[1]?.toLowerCase()
    return segs.length === 2 && segs[0] === 'meet' && code && MEET_CODE.test(code) ? found('meet', code) : null
  }
  if (u.protocol !== 'https:') return null

  if (host === 'meet.google.com') {
    const code = segs[0]?.toLowerCase()
    if (code && MEET_CODE.test(code)) return found('meet', code)
    if (segs[0] === 'lookup' && segs[1]) return found('meet', `lookup/${segs[1]}`)
    return null
  }

  if (isHost(host, 'zoom.us') || isHost(host, 'zoomgov.com')) {
    const [a, b, c] = segs
    if ((a === 'j' || a === 's') && b && ZOOM_ID.test(b)) return found('zoom', b)
    if (a === 'wc' && b && ZOOM_ID.test(b) && (c === undefined || c === 'join' || c === 'start')) return found('zoom', b)
    if (a === 'wc' && b === 'join' && c && ZOOM_ID.test(c)) return found('zoom', c)
    if (a === 'my' && b && ROOM.test(b) && segs.length === 2) return found('zoom', `my/${b.toLowerCase()}`)
    return null
  }

  if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft') {
    // Teams puts the meetup link in the path, or behind the hash in its web app.
    const link = /\/l\/meetup-join\/([^/?#]+)/.exec(`${u.pathname}${u.hash}`)
    if (link?.[1]) return found('teams', decode(link[1]))
    if (segs[0] === 'meet' && segs[1] && /^\d{6,20}$/.test(segs[1])) return found('teams', `meet/${segs[1]}`)
    return null
  }

  if (isHost(host, 'webex.com')) {
    if (segs[0] === 'meet' && segs[1] && ROOM.test(segs[1]) && segs.length === 2) return found('webex', `${host}/${segs[1].toLowerCase()}`)
    const mtid = u.searchParams.get('MTID')
    if (segs[segs.length - 1] === 'j.php' && mtid) return found('webex', mtid)
    const join = /\/(?:wbxmjs\/joinservice|webappng)\/sites\/[^/]+\/meeting\/(?:download\/|info\/)?([0-9a-f]{16,})/i.exec(u.pathname)
    if (join?.[1]) return found('webex', join[1].toLowerCase())
    return null
  }

  if (isHost(host, 'whereby.com')) {
    const sub = host === 'whereby.com' ? null : host.slice(0, -'.whereby.com'.length)
    if (sub && WHEREBY_SUBDOMAINS.has(sub)) return null
    const room = segs[0]?.toLowerCase()
    if (segs.length !== 1 || !room || !ROOM.test(room) || room.includes('.') || WHEREBY_RESERVED.has(room)) return null
    return found('whereby', `${host}/${room}`)
  }

  if (host === 'meet.jit.si') {
    const room = segs[0]?.toLowerCase()
    if (segs.length !== 1 || !room || room.includes('.') || JITSI_RESERVED.has(room)) return null
    return found('jitsi', `${host}/${decode(room)}`)
  }
  if (host === '8x8.vc') {
    const [tenant, room] = segs
    if (segs.length !== 2 || !tenant || !room || room.includes('.') || JITSI_RESERVED.has(tenant)) return null
    return found('jitsi', `${host}/${tenant}/${decode(room).toLowerCase()}`)
  }
  return null
}

/** The permissions a meeting needs that are not granted yet, in checklist order. */
export function missingPermissions(p: SpeechPermissions): PermissionKind[] {
  const missing: PermissionKind[] = []
  if (p.microphone !== 'granted') missing.push('microphone')
  if (p.speech !== 'granted') missing.push('speech')
  if (p.screen !== 'granted') missing.push('screen')
  return missing
}

/** Elapsed time as a clock: 0:05, 12:34, 1:02:03. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export type CaptureState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'processing'

export interface CaptureStatus {
  state: CaptureState
  meetingId: string | null
  startedAt: number | null
  /** Pauses excluded. */
  elapsedMs: number
  systemAudio: boolean
  origin: { tabId: string | null; url: string | null }
  warnings: Array<'screen-missing' | 'device-fallback' | 'interrupted'>
  /** 'lid' while the lid is closed. */
  pausedBy: 'user' | 'lid' | null
  /** Recording audio only (chosen, or this Mac can't transcribe), and why. */
  audioOnly: AudioOnlyReason | null
}

export const IDLE_CAPTURE: CaptureStatus = {
  state: 'idle',
  meetingId: null,
  startedAt: null,
  elapsedMs: 0,
  systemAudio: false,
  origin: { tabId: null, url: null },
  warnings: [],
  pausedBy: null,
  audioOnly: null,
}

export interface CaptureStartOptions {
  kind: 'meeting' | 'recording'
  tabId?: string
  url?: string
  title?: string
  /** Main only (desktop calls): the app whose call this records; `audio` limits the other side to those apps' sound. */
  call?: { app: DesktopCallAppId; audio: string[] }
  /** Main only (a card that offered to record audio only): record without transcribing, and don't ask for Speech Recognition. */
  audioOnly?: boolean
}

/** 'app': a call started in a desktop app (Zoom, Teams, FaceTime…). */
export type CardMode = 'site' | 'calendar' | 'permissions' | 'continue' | 'app'

/** The meeting-card float's payload. */
export interface CardPayload {
  mode: CardMode
  provider: MeetingProvider | null
  title: string
  host: string | null
  reason?: 'long' | 'silent'
  countdownMs?: number
  missing?: PermissionKind[]
  /** Which card this is; an action naming another card (a stale click) is ignored. */
  id?: string
  /** calendar mode: when the meeting starts. */
  startsAt?: number
  /** calendar mode: the event has a link to join. */
  joinable?: boolean
  /** permissions mode: only Screen Recording is missing, so recording the microphone alone still works. */
  canRecord?: boolean
  /** Desktop calls (app mode, or a permissions card for one): the app on the call. */
  app?: DesktopCallAppId
  /** Recording would be audio only (Record audio only is chosen, or Speech Recognition is off): the card offers to record, not to take notes. */
  audioOnly?: boolean
}

/** A permissions card that can still record: what recording without the missing ones gives you. */
export function cardPermissionBody(card: Pick<CardPayload, 'missing'>): 'capture.card.screenOnlyBody' | 'capture.card.speechOffBody' | 'capture.card.speechScreenOffBody' {
  const speech = card.missing?.includes('speech') === true
  if (!speech) return 'capture.card.screenOnlyBody'
  return card.missing?.includes('screen') ? 'capture.card.speechScreenOffBody' : 'capture.card.speechOffBody'
}

export const CARD_ACTIONS = [
  'record', 'join-only', 'settings', 'setup', 'dont-show-again', 'continue', 'stop', 'dismiss', 'mute-kind', 'mute-site', 'mute-all', 'mute-app',
] as const
export type CardAction = (typeof CARD_ACTIONS)[number]

export const WRAP_UP_ACTIONS = ['discuss', 'view-summary', 'open-meetings', 'dismiss'] as const
/**
 * 'discuss' carries the new chat's id: the wrap-up starts the chat itself
 * through `meetings.discuss(meetingId, companionId)` (on its allowlist), and
 * main then opens the chat and closes the card.
 */
export type WrapUpAction = (typeof WRAP_UP_ACTIONS)[number]

/** The recording-widget float's payload: the live status, then the wrap-up once stopped (MV-11). */
export interface RecordingPayload {
  status: CaptureStatus
  wrapUp: WrapUp | null
}

/** The wrap-up card (MV-11). */
export interface WrapUp {
  meetingId: string
  title: string
  phase: 'processing' | 'ready' | 'no-engine' | 'failed'
  /** The summary was written (ready); false means the transcript alone was saved. */
  summarized?: boolean
  /** failed: what went wrong. */
  error?: SpeechErrorCode | null
  /** Recorded as audio only, and why: the card says the recording is saved. */
  audioOnly?: AudioOnlyReason | null
}

export interface CalendarEvent {
  id: string
  title: string
  startsAt: number
  url: string | null
  /** Calendar events carry these too (a desktop call takes the name of the event happening now). */
  endsAt?: number
  allDay?: boolean
}

/** Null until the calendar feature calls setCalendarSource(source). */
export interface CalendarSource {
  upcoming(withinMs: number): Promise<CalendarEvent[]>
}

export interface MeetingRecorder {
  status(): CaptureStatus
  start(o: CaptureStartOptions): Promise<string>
  stop(): Promise<void>
  pause(by?: 'user' | 'lid'): void
  resume(by?: 'user' | 'lid'): void
  on(event: 'status', fn: (status: CaptureStatus) => void): unknown
}

export type MeetingCardKind = 'site' | 'calendar' | 'permissions'

export interface MeetingCardSettings {
  /** Every card muted. */
  all: boolean
  kinds: MeetingCardKind[]
  /** Lowercase hosts, deduped, at most MUTED_SITES_MAX. */
  sites: string[]
}

export const MUTED_SITES_MAX = 200


export interface MeetingCaptureServices {
  meetingCapture: {
    status(): CaptureStatus
    /** Resolves to the new meeting's id. */
    start(o: CaptureStartOptions): Promise<string>
    stop(): Promise<void>
    pause(): void
    resume(): void
  }
}

export type MeetingCaptureAppEvent = { type: 'meeting-capture'; status: CaptureStatus }
