/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { strToU8, zipSync, type ZippableFile } from 'fflate'
import { REPORT_IMAGE_MAX_BYTES, REPORT_MAX_BYTES, type CrashState, type ReportEstimate, type ReportPartKind } from '@shared/diagnostics'
import type { MigrationReport } from '@shared/migrations'
import { redact } from './redact'

// The problem report bundle (OV-30): one zip, written with fflate, holding
// report.json (schema 1), description.txt, images/, files/, chat.md,
// screenshot.png, logs/ (redacted again) and crash/*.dmp. Pure Node: the
// service gathers the parts with Electron and hands them here, so tests can
// build and read back bundles without it.

export const REPORT_SCHEMA = 1
/** Raw log text bundled, newest files first; the zip shrinks it a lot. */
export const REPORT_LOGS_MAX_BYTES = 6 * 1024 * 1024
// JSON-lines logs and Markdown compress well; this keeps the estimate on the safe side.
const TEXT_RATIO = 0.35
// Local headers and the central directory, per entry.
const ZIP_ENTRY_OVERHEAD = 120

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export interface ReportJson {
  schema: typeof REPORT_SCHEMA
  createdAt: string
  app: string
  channel: string
  os: string
  arch: string
  electron: string
  chrome: string
  node: string
  locale: string
  engineKind: string
  settingsSummary: Record<string, string | number | boolean>
  counts: Record<string, number>
  migrations: MigrationReport | null
  crash: CrashState
  included: { chat: boolean; screenshot: 'yes' | 'no' | 'unavailable'; images: number; files: number; crashDumps: number; logFiles: number }
}

export interface ReportParts {
  json: ReportJson
  description: string
  images: Array<{ name: string; bytes: Uint8Array }>
  /** Read from disk when the zip is built. */
  files: Array<{ name: string; path: string }>
  chatMarkdown: string | null
  screenshot: Uint8Array | null
  logs: Array<{ name: string; text: string }>
  dumps: Array<{ name: string; path: string }>
}

/** "Apex problem report 2026-10-29 14.05.zip", in local time. */
export function reportFileName(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${BRAND_NAME} problem report ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.zip`
}

/** A free path in `dir`: the name, then "name (2).zip", "name (3).zip"… */
export function uniquePath(dir: string, name: string, exists: (path: string) => boolean = existsSync): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = join(dir, name)
  for (let i = 2; exists(candidate) && i < 1000; i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}

/** A file name safe inside the zip (no folders, no dot-dot), unique among `taken`. */
export function entryName(name: string, taken: Set<string>, fallback = 'file'): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\.{2,}/g, '.').replace(/^[.\s]+/, '').trim().slice(0, 120) || fallback
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  let candidate = cleaned
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`
  taken.add(candidate.toLowerCase())
  return candidate
}

/** A pasted image's bytes and extension; throws on anything but a base64 png, jpeg, webp or gif up to 5 MB. */
export function decodeImage(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  const ext = match ? IMAGE_TYPES[match[1] ?? ''] : undefined
  if (!match || !ext) throw new Error('An image could not be read.')
  const bytes = new Uint8Array(Buffer.from(match[2] ?? '', 'base64'))
  if (bytes.length > REPORT_IMAGE_MAX_BYTES) throw new Error('An image is over the size limit.')
  return { ext, bytes }
}

/** The decoded size of a base64 data URL, without decoding it. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

// Settings that may hold who you are or where things live never reach a report.
const SUMMARY_STRINGS = new Set(['model', 'effort', 'engine', 'layout', 'theme', 'panelDock', 'density', 'appLanguage', 'bookmarksBar', 'externalTabs'])
const SUMMARY_SKIP = new Set(['userName', 'userAvatar', 'downloadDir', 'customSearchEngines', 'proxy'])
/** Any path or folder setting, an engine's own included. */
const SUMMARY_SKIP_PATTERN = /(?:Path|Dir)$/

/** Booleans, numbers and a few known enum strings, one level deep; never the name, picture or paths. */
export function settingsSummary(settings: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  const add = (key: string, value: unknown, stringOk: boolean): void => {
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value
    else if (stringOk && typeof value === 'string' && value.length <= 40) out[key] = value
  }
  for (const [key, value] of Object.entries(settings)) {
    if (SUMMARY_SKIP.has(key) || SUMMARY_SKIP_PATTERN.test(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, v] of Object.entries(value as Record<string, unknown>)) add(`${key}.${inner}`, v, false)
    } else {
      add(key, value, SUMMARY_STRINGS.has(key))
    }
  }
  return out
}

/** The newest log files that fit `maxBytes`, each line redacted again (the files were written before any secret registered later). */
export function reportLogs(files: ReadonlyArray<{ name: string; path: string; bytes: number }>, maxBytes = REPORT_LOGS_MAX_BYTES, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  let used = 0
  for (const file of files) {
    if (out.length > 0 && used + file.bytes > maxBytes) break
    let text = ''
    try {
      text = read(file.path)
    } catch {
      continue
    }
    used += Math.max(file.bytes, text.length)
    if (text.length > maxBytes) text = text.slice(text.length - maxBytes)
    out.push({ name: file.name, text: text.split('\n').map(redact).join('\n') })
  }
  return out
}

export interface EstimateInput {
  /** report.json and description.txt. */
  systemBytes: number
  logBytes: number
  chatBytes: number
  screenshotBytes: number
  fileBytes: number
  imageBytes: number
  crashBytes: number
  entries: number
}

/** The zip's likely size: text parts shrink, images, files and dumps mostly don't. */
export function estimateReport(input: EstimateInput): ReportEstimate {
  const parts: ReportEstimate['parts'] = []
  const push = (kind: ReportPartKind, bytes: number): void => {
    if (bytes > 0) parts.push({ kind, bytes: Math.round(bytes) })
  }
  push('system', input.systemBytes * TEXT_RATIO)
  push('logs', input.logBytes * TEXT_RATIO)
  push('chat', input.chatBytes * TEXT_RATIO)
  push('screenshot', input.screenshotBytes)
  push('files', input.fileBytes)
  push('images', input.imageBytes)
  push('crash', input.crashBytes)
  const bytes = parts.reduce((sum, p) => sum + p.bytes, 0) + input.entries * ZIP_ENTRY_OVERHEAD
  return { bytes, overLimit: bytes > REPORT_MAX_BYTES, parts }
}

/** Every zip entry, by path. Already-compressed parts are stored, not deflated again. */
export function reportEntries(parts: ReportParts, read: (path: string) => Uint8Array = (p) => new Uint8Array(readFileSync(p))): Record<string, ZippableFile> {
  const entries: Record<string, ZippableFile> = {}
  const stored = (bytes: Uint8Array): ZippableFile => [bytes, { level: 0 }]
  entries['report.json'] = strToU8(`${JSON.stringify(parts.json, null, 2)}\n`)
  entries['description.txt'] = strToU8(`${parts.description.trim()}\n`)
  const imageNames = new Set<string>()
  for (const image of parts.images) entries[`images/${entryName(image.name, imageNames, 'image')}`] = stored(image.bytes)
  const fileNames = new Set<string>()
  for (const file of parts.files) entries[`files/${entryName(file.name, fileNames)}`] = read(file.path)
  if (parts.chatMarkdown !== null) entries['chat.md'] = strToU8(parts.chatMarkdown)
  if (parts.screenshot) entries['screenshot.png'] = stored(parts.screenshot)
  for (const log of parts.logs) entries[`logs/${log.name}`] = strToU8(log.text)
  const dumpNames = new Set<string>()
  for (const dump of parts.dumps) entries[`crash/${entryName(dump.name, dumpNames, 'crash.dmp')}`] = read(dump.path)
  return entries
}

export function zipReport(entries: Record<string, ZippableFile>, mtime: Date = new Date()): Uint8Array {
  return zipSync(entries, { level: 6, mtime })
}
