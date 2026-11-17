/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Getting packs from elsewhere (docs/packs.md › Sharing): an .atelierpack from a
// link, a community index (an https JSON file listing packs with their
// SHA-256), and update checks against a pack's updateUrl. Downloads are https
// (http only on this computer), follow at most five redirects, and stop at
// the size limit before reading more.
import { BRAND_NAME } from '@shared/branding'
import { z } from 'zod'
import { APP_PACK_LIMITS, PACK_ID_PATTERN, PACK_INDEX_CATEGORIES, PACK_INDEX_FORMAT, PACK_INDEX_KINDS, PACK_LIMITS, PACK_SHARE_IMAGE_MAX, PACK_VERSION_PATTERN } from '@shared/packs'

export class PackDownloadError extends Error {}

/** A pack with an app may be as large as APP_PACK_LIMITS; decodeArchive holds a pack without one to the smaller limits. */
const DOWNLOAD_MAX = APP_PACK_LIMITS.packBytes + 1024 * 1024
const TIMEOUT_MS = 30_000

/** Whether Atelier fetches this address for a pack or an index. */
export function downloadAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.username || u.password) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

async function get(url: string, max: number, doFetch: typeof fetch): Promise<Buffer> {
  let at = url
  for (let hop = 0; hop < 6; hop++) {
    if (!downloadAllowed(at)) throw new PackDownloadError(`${BRAND_NAME} only downloads packs over https.`)
    let res: Response
    try {
      res = await doFetch(at, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new PackDownloadError(`The download failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      at = new URL(location, at).href
      continue
    }
    if (!res.ok) throw new PackDownloadError(`The server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`)
    const length = Number(res.headers.get('content-length') ?? '0')
    if (length > max) throw new PackDownloadError('The file is too large.')
    if (!res.body) return Buffer.alloc(0)
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => undefined)
        throw new PackDownloadError('The file is too large.')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }
  throw new PackDownloadError('Too many redirects.')
}

export function downloadPack(url: string, doFetch: typeof fetch = fetch): Promise<Buffer> {
  return get(url, DOWNLOAD_MAX, doFetch)
}

const indexEntry = z.object({
  id: z.string().regex(PACK_ID_PATTERN),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  version: z.string().regex(PACK_VERSION_PATTERN),
  url: z.string().max(2048).refine(downloadAllowed),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).transform((s) => s.toLowerCase()),
  author: z.string().max(80).optional(),
  // docs/apps.md › The community index: what it is, its picture, its shelf, its size and its colour. All optional.
  kind: z.enum(PACK_INDEX_KINDS).default('pack'),
  image: z.string().max(2048).refine(downloadAllowed).optional(),
  category: z.enum(PACK_INDEX_CATEGORIES).optional(),
  size: z.number().int().min(0).max(DOWNLOAD_MAX).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
})

const indexSchema = z.object({
  format: z.literal(PACK_INDEX_FORMAT),
  name: z.string().max(80).optional(),
  packs: z.array(z.unknown()).max(2_000),
  /** Ids the index no longer offers: Atelier hides them, offers no updates, and shows a notice on installed copies. */
  withdrawn: z.array(z.unknown()).max(2_000).optional(),
})

const withdrawnEntry = z.object({ id: z.string().regex(PACK_ID_PATTERN), reason: z.string().trim().max(300).optional() })

export interface PackIndexFile {
  name: string | null
  packs: Array<z.infer<typeof indexEntry>>
  withdrawn: Array<{ id: string; reason: string | null }>
  /** Entries that didn't parse, skipped. */
  skipped: number
}

/** Reads an index; entries that don't parse are skipped, not fatal. */
export function parseIndex(text: string): PackIndexFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PackDownloadError('This address isn’t a pack index (it isn’t JSON).')
  }
  const parsed = indexSchema.safeParse(raw)
  if (!parsed.success) throw new PackDownloadError(`This address isn’t a pack index (it needs "format": "${PACK_INDEX_FORMAT}" and a "packs" list).`)
  const withdrawn: PackIndexFile['withdrawn'] = []
  for (const entry of parsed.data.withdrawn ?? []) {
    const w = withdrawnEntry.safeParse(entry)
    if (w.success && !withdrawn.some((x) => x.id === w.data.id)) withdrawn.push({ id: w.data.id, reason: w.data.reason || null })
  }
  const gone = new Set(withdrawn.map((w) => w.id))
  const packs: PackIndexFile['packs'] = []
  let skipped = 0
  for (const entry of parsed.data.packs) {
    const e = indexEntry.safeParse(entry)
    // A withdrawn id is never offered, even if an entry for it is still listed.
    if (e.success && !gone.has(e.data.id) && !packs.some((p) => p.id === e.data.id)) packs.push(e.data)
    else skipped++
  }
  return { name: parsed.data.name?.trim() || null, packs, withdrawn, skipped }
}

/** An index entry's picture: PNG or JPEG, at most the share image's size. */
export async function downloadImage(url: string, doFetch: typeof fetch = fetch): Promise<{ mediaType: 'image/png' | 'image/jpeg'; data: Buffer }> {
  const data = await get(url, PACK_SHARE_IMAGE_MAX, doFetch)
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mediaType: 'image/png', data }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mediaType: 'image/jpeg', data }
  throw new PackDownloadError('That picture is not a PNG or JPEG.')
}

export async function fetchIndex(url: string, doFetch: typeof fetch = fetch): Promise<PackIndexFile> {
  return parseIndex((await get(url, PACK_LIMITS.indexBytes, doFetch)).toString('utf8'))
}
