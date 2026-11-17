/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Download contract additions and the pure rules behind the
// downloads popover, the fly-to-button cue and the Downloads page: speed and
// time left, when the popover opens by itself, which state a row is in and
// what it offers, the file-type icon, and the flight's curve. No DOM and no
// Electron, so all of it is unit-tested.
import { t } from './i18n/core'

export type DownloadDanger = 'none' | 'uncommon' | 'dangerous'

/** Where downloads go (Settings › Downloads, ST-45). */
export interface DownloadFolderView {
  /** The folder new downloads use right now (the default while a chosen one is missing). */
  path: string
  /** The system Downloads folder. */
  defaultPath: string
  /** The person picked a folder (settings.downloadDir is set). */
  custom: boolean
  /** The picked folder is gone, so downloads fall back to the default. */
  missing: boolean
}

/** The slice of DownloadInfo the popover draws; the chrome picks these fields before it opens the surface. */
export interface DownloadRow {
  id: string
  url: string
  filename: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  receivedBytes: number
  totalBytes: number
  startedAt: number
  speedBps: number
  etaSeconds: number | null
  danger: DownloadDanger
  byAgent: boolean
  mime: string
}

/** Props of the `downloads` popover (OV-17); null items show the loading rows. */
export interface DownloadsPopoverProps {
  /** The newest rows, at most POPOVER_MAX_ROWS. */
  items: DownloadRow[] | null
  /** How many downloads the list holds in all (the rest are on the Downloads page). */
  total: number
}

export interface Point {
  x: number
  y: number
}

/** Props of the `download-flight` cue (OV-19): window coordinates in chrome CSS px. */
export interface DownloadFlightProps {
  from: Point
  to: Point
  kind: FileKind
}

/** The popover shows the newest few; the Downloads page has the rest. */
export const POPOVER_MAX_ROWS = 30

/** "Under about 10 MB" opens the popover by itself (OV-18). */
export const AUTO_OPEN_MAX_BYTES = 10 * 1024 * 1024

/** The whole flight, bounce included, never runs longer than this (OV-19). */
export const FLIGHT_MAX_MS = 2000

// ---- speed and time left ----

export interface SpeedSample {
  at: number
  bytes: number
  bps: number
}

/** Samples closer together than this are folded into the next one, so bursts don't spike the speed. */
export const SPEED_MIN_SAMPLE_MS = 200
/** How much each new sample moves the smoothed speed. */
export const SPEED_SMOOTHING = 0.3

/** The smoothed transfer speed after `bytes` were received by `at` (ms). */
export function nextSpeed(prev: SpeedSample | null, bytes: number, at: number): SpeedSample {
  if (!prev) return { at, bytes, bps: 0 }
  const dt = at - prev.at
  if (dt < SPEED_MIN_SAMPLE_MS) return prev
  const instant = (Math.max(0, bytes - prev.bytes) * 1000) / dt
  // The first measured interval sets the speed outright; later ones are smoothed.
  const bps = prev.bps === 0 ? instant : prev.bps + SPEED_SMOOTHING * (instant - prev.bps)
  return { at, bytes, bps: Math.max(0, bps) }
}

/** Whole seconds left at `bps`; null when the size or the speed is unknown. */
export function etaSeconds(received: number, total: number, bps: number): number | null {
  if (total <= 0 || bps <= 0) return null
  return Math.ceil(Math.max(0, total - received) / bps)
}

/** 0–100, or null while the size is unknown. */
export function downloadPercent(d: Pick<DownloadRow, 'receivedBytes' | 'totalBytes'>): number | null {
  if (d.totalBytes <= 0) return null
  return Math.min(100, Math.floor((d.receivedBytes / d.totalBytes) * 100))
}

// ---- auto-open (OV-18) ----

export interface AutoOpenInput {
  byAgent: boolean
  /** The person chose where to save it in the save dialog. */
  askedWhere: boolean
  totalBytes: number
  danger: DownloadDanger
}

/**
 * The popover opens by itself for downloads you started: after you chose
 * where to save, when the file waits for Keep or Discard, or when it is
 * under about 10 MB. Agent downloads never open it; the agent reports them.
 */
export function shouldAutoOpen(d: AutoOpenInput): boolean {
  if (d.byAgent) return false
  if (d.askedWhere || d.danger !== 'none') return true
  return d.totalBytes > 0 && d.totalBytes <= AUTO_OPEN_MAX_BYTES
}

// ---- row states and actions ----

export type DownloadPhase = 'running' | 'review' | 'done' | 'failed' | 'cancelled'

export type DownloadAction = 'cancel' | 'keep' | 'discard' | 'open' | 'reveal' | 'drag' | 'retry' | 'remove'

/** A flagged file waits for Keep or Discard until it is cancelled or fails. */
export function downloadPhase(d: Pick<DownloadRow, 'state' | 'danger'>): DownloadPhase {
  if (d.danger !== 'none' && (d.state === 'progressing' || d.state === 'completed')) return 'review'
  if (d.state === 'progressing') return 'running'
  if (d.state === 'completed') return 'done'
  return d.state === 'cancelled' ? 'cancelled' : 'failed'
}

const ACTIONS: Record<DownloadPhase, readonly DownloadAction[]> = {
  running: ['cancel'],
  review: ['keep', 'discard'],
  done: ['open', 'reveal', 'drag', 'remove'],
  failed: ['retry', 'remove'],
  cancelled: ['retry', 'remove'],
}

export function downloadActions(phase: DownloadPhase): readonly DownloadAction[] {
  return ACTIONS[phase]
}

/** The popover's props from the whole list: the newest rows, and the count. */
export function popoverProps(list: readonly DownloadRow[]): DownloadsPopoverProps {
  return { items: list.slice(0, POPOVER_MAX_ROWS).map(toDownloadRow), total: list.length }
}

/** Clear finished leaves running downloads and those still waiting for a decision. */
export function isClearable(d: Pick<DownloadRow, 'state' | 'danger'>): boolean {
  const phase = downloadPhase(d)
  return phase !== 'running' && phase !== 'review'
}

/** Row URLs only name the site, so long ones (data: URLs) are cut. */
export const ROW_URL_MAX = 2048

export function toDownloadRow(d: DownloadRow): DownloadRow {
  return {
    id: d.id,
    url: d.url.slice(0, ROW_URL_MAX),
    filename: d.filename,
    state: d.state,
    receivedBytes: d.receivedBytes,
    totalBytes: d.totalBytes,
    startedAt: d.startedAt,
    speedBps: d.speedBps,
    etaSeconds: d.etaSeconds,
    danger: d.danger,
    byAgent: d.byAgent,
    mime: d.mime,
  }
}

// ---- file kinds (the row's icon) ----

export type FileKind = 'archive' | 'installer' | 'image' | 'video' | 'audio' | 'pdf' | 'sheet' | 'slides' | 'doc' | 'code' | 'file'

export const FILE_KINDS: readonly FileKind[] = ['archive', 'installer', 'image', 'video', 'audio', 'pdf', 'sheet', 'slides', 'doc', 'code', 'file']

const EXTENSIONS: Record<Exclude<FileKind, 'file'>, readonly string[]> = {
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
  installer: ['dmg', 'pkg', 'exe', 'msi', 'app', 'deb', 'rpm', 'apk', 'appimage', 'mpkg'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'ico'],
  video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff'],
  pdf: ['pdf'],
  sheet: ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods'],
  slides: ['ppt', 'pptx', 'key', 'odp'],
  doc: ['txt', 'md', 'rtf', 'doc', 'docx', 'pages', 'odt', 'epub'],
  code: ['json', 'js', 'mjs', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'html', 'htm', 'css', 'xml', 'yml', 'yaml', 'sh', 'sql'],
}

const BY_EXTENSION = new Map<string, FileKind>(Object.entries(EXTENSIONS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind as FileKind] as const)))

/** The file's kind from its extension, then its MIME type. */
export function fileKind(filename: string, mime = ''): FileKind {
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
  const known = BY_EXTENSION.get(ext)
  if (known) return known
  const type = mime.toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  if (type === 'application/pdf') return 'pdf'
  if (type === 'application/zip' || type.includes('compressed')) return 'archive'
  if (type.startsWith('text/')) return 'doc'
  return 'file'
}

// ---- wording ----

const UNITS = ['KB', 'MB', 'GB', 'TB'] as const

/** "512 B", "1.4 MB", "23 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return t('downloads.size.bytes', { n: Math.max(0, Math.round(bytes)) })
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`
}

/** "1.2 MB/s". */
export function formatSpeed(bps: number): string {
  return t('downloads.speed', { size: formatSize(bps) })
}

/** "8 s left", "3 min left", "1 h 5 min left". */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 60) return t('downloads.eta.seconds', { n: Math.max(1, Math.ceil(seconds)) })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('downloads.eta.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? t('downloads.eta.hoursMinutes', { h: hours, m: rest }) : t('downloads.eta.hours', { n: hours })
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The line under a download's name: progress, size and site, or what went wrong. */
export function downloadStatus(d: DownloadRow): string {
  const phase = downloadPhase(d)
  if (phase === 'review') return d.danger === 'dangerous' ? t('downloads.status.dangerous') : t('downloads.status.uncommon', { host: hostOfUrl(d.url) || t('downloads.status.thisSite') })
  if (phase === 'cancelled') return t('downloads.status.cancelled')
  if (phase === 'failed') return t('downloads.status.failed')
  if (phase === 'done') {
    const host = hostOfUrl(d.url)
    return host ? t('downloads.status.doneFrom', { size: formatSize(d.receivedBytes), host }) : formatSize(d.receivedBytes)
  }
  if (d.receivedBytes === 0 && d.speedBps === 0) return t('downloads.status.starting')
  const parts: string[] = []
  const percent = downloadPercent(d)
  parts.push(d.totalBytes > 0 ? t('downloads.status.amountOf', { received: formatSize(d.receivedBytes), total: formatSize(d.totalBytes) }) : formatSize(d.receivedBytes))
  if (percent !== null) parts.push(t('downloads.status.percent', { n: percent }))
  if (d.speedBps > 0) parts.push(formatSpeed(d.speedBps))
  if (d.etaSeconds !== null) parts.push(formatTimeLeft(d.etaSeconds))
  return parts.join(' · ')
}

// ---- the flight (OV-19) ----

/** The curve's pull point: the icon rises toward the button's row early and arrives level with it. */
export function flightControl(from: Point, to: Point): Point {
  return { x: from.x + (to.x - from.x) * 0.35, y: Math.max(0, from.y + (to.y - from.y) * 0.95) }
}

/** A point on the quadratic curve at progress `p` (0–1). */
export function flightPoint(from: Point, to: Point, p: number): Point {
  const c = flightControl(from, to)
  const q = Math.min(1, Math.max(0, p))
  const a = (1 - q) * (1 - q)
  const b = 2 * (1 - q) * q
  const d = q * q
  return { x: a * from.x + b * c.x + d * to.x, y: a * from.y + b * c.y + d * to.y }
}

/** Travel time grows with distance, between 0.55 and 1.3 s. */
export function flightTravelMs(from: Point, to: Point): number {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  return Math.round(Math.min(1300, Math.max(550, 450 + distance * 0.6)))
}

/** The small bounce after arrival. */
export const FLIGHT_BOUNCE_MS = 320

export interface FlightFrame {
  offset: number
  x: number
  y: number
  scale: number
  opacity: number
}

/** Ease-in-out for the travel (the icon lifts off and settles into the button). */
function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2
}

/**
 * Keyframes for the whole flight: travel along the curve, shrinking a little,
 * then a small bounce at the button and a fade. Offsets are 0–1 of
 * `flightDuration`, which never exceeds FLIGHT_MAX_MS.
 */
export function flightFrames(from: Point, to: Point, steps = 20): FlightFrame[] {
  const travel = flightTravelMs(from, to)
  const total = flightDuration(from, to)
  const frames: FlightFrame[] = []
  for (let i = 0; i <= steps; i++) {
    const p = i / steps
    const point = flightPoint(from, to, easeInOut(p))
    frames.push({ offset: (p * travel) / total, x: point.x, y: point.y, scale: 1.15 - 0.4 * p, opacity: i === 0 ? 0 : 1 })
  }
  // The bounce: up a few px, over-grow, settle, then fade into the button.
  const at = (ms: number): number => Math.min(1, (travel + ms) / total)
  frames.push({ offset: at(FLIGHT_BOUNCE_MS * 0.35), x: to.x, y: to.y - 6, scale: 0.9, opacity: 1 })
  frames.push({ offset: at(FLIGHT_BOUNCE_MS * 0.7), x: to.x, y: to.y, scale: 0.72, opacity: 1 })
  frames.push({ offset: 1, x: to.x, y: to.y, scale: 0.6, opacity: 0 })
  return frames
}

export function flightDuration(from: Point, to: Point): number {
  return Math.min(FLIGHT_MAX_MS, flightTravelMs(from, to) + FLIGHT_BOUNCE_MS)
}
