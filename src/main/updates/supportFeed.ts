/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { SupportFeed } from '@shared/updates'

// Unsupported versions (UP-02): an optional static list in the release feed,
// `atelier-support.json`, marks versions below a floor as unsupported. It is
// fetched only when updates are enabled, with no identifiers in the request,
// and anything malformed is ignored.

/** Parses x.y.z (a leading v and a -prerelease or +build suffix are allowed); null if it isn't one. */
export function parseVersion(text: string): { core: [number, number, number]; pre: string | null } | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null }
}

function comparePre(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i]
    const y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1
    } else if (nx !== null) return -1
    else if (ny !== null) return 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Semver order: -1, 0 or 1. A prerelease sorts before its release. Text
 * that isn't a version sorts before every version, so a bad string never
 * looks newer than a real one.
 */
export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return va ? 1 : vb ? -1 : 0
  for (let i = 0; i < 3; i++) {
    const d = va.core[i]! - vb.core[i]!
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (va.pre === vb.pre) return 0
  if (va.pre === null) return 1
  if (vb.pre === null) return -1
  return comparePre(va.pre, vb.pre)
}

const FEED_MAX_ENTRIES = 50

const feedSchema = z.object({
  schema: z.literal(1),
  unsupported: z
    .array(
      z.object({
        below: z.string().max(32).refine((v) => parseVersion(v) !== null),
        message: z.string().max(500).optional(),
      }),
    )
    .max(FEED_MAX_ENTRIES),
})

/** The feed, or null for bad JSON, another schema or a malformed entry. Unknown fields are ignored. */
export function parseSupportFeed(text: string): SupportFeed | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = feedSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    schema: 1,
    unsupported: parsed.data.unsupported.map((e) => (e.message === undefined ? { below: e.below } : { below: e.below, message: e.message })),
  }
}

/** The entry that makes `version` unsupported (the highest floor it is under), or null. */
export function unsupportedFor(feed: SupportFeed | null, version: string): { below: string; message: string | null } | null {
  if (!feed || !parseVersion(version)) return null
  let match: { below: string; message: string | null } | null = null
  for (const entry of feed.unsupported) {
    if (compareVersions(version, entry.below) >= 0) continue
    if (!match || compareVersions(entry.below, match.below) > 0) match = { below: entry.below, message: entry.message?.trim() || null }
  }
  return match
}

/** The feed's address on the latest GitHub release. */
export function supportFeedUrl(repo: { owner: string; name: string }): string {
  return `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/releases/latest/download/atelier-support.json`
}

export const SUPPORT_FEED_MAX_BYTES = 64 * 1024

/**
 * Fetches and parses the feed. Plain fetch: no cookies, no referrer and no
 * Atelier identifiers. Any failure (offline, 404, too big, bad JSON) is null.
 */
export async function fetchSupportFeed(url: string, fetcher: typeof fetch = fetch, timeoutMs = 15_000): Promise<SupportFeed | null> {
  try {
    const res = await fetcher(url, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const text = await res.text()
    if (text.length > SUPPORT_FEED_MAX_BYTES) return null
    return parseSupportFeed(text)
  } catch {
    return null
  }
}
