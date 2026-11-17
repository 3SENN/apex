/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Cookie, Session, WebContents } from 'electron'
import { displayHost } from '@shared/domains'
import type { SiteDataEntry } from '@shared/sites'
import { cdp } from './cdp'

// What sites keep on this computer (SH-37): cookie counts by
// registrable domain, a site's stored data and cache sizes (measured through
// the shared CDP session of a tab showing it), and clearing either one.

const DATA_TYPES = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'] as const
const CACHE_USAGE = new Set(['cache_storage', 'service_workers', 'shader_cache'])

/** The registrable domain a cookie belongs to ("www.example.com" and ".example.com" are both example.com). */
export function cookieDomain(cookie: Pick<Cookie, 'domain'>): string {
  const host = (cookie.domain ?? '').replace(/^\./, '').toLowerCase()
  return displayHost(`https://${host}`).registrable || host
}

/** Groups cookies by registrable domain, most cookies first, then by name. */
export function groupCookies(cookies: readonly Pick<Cookie, 'domain'>[]): SiteDataEntry[] {
  const byDomain = new Map<string, { cookies: number; hosts: Set<string> }>()
  for (const c of cookies) {
    const domain = cookieDomain(c)
    if (!domain) continue
    const entry = byDomain.get(domain) ?? { cookies: 0, hosts: new Set<string>() }
    entry.cookies++
    entry.hosts.add((c.domain ?? '').replace(/^\./, '').toLowerCase())
    byDomain.set(domain, entry)
  }
  return [...byDomain.entries()]
    .map(([domain, e]) => ({ domain, cookies: e.cookies, hosts: [...e.hosts].sort() }))
    .sort((a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain))
}

/** Whether a cookie belongs to a registrable domain (the domain itself or any subdomain). */
export function cookieInDomain(cookie: Pick<Cookie, 'domain'>, domain: string): boolean {
  return cookieDomain(cookie) === domain.toLowerCase()
}

/** The cookies that would be sent to a site (its registrable domain's). */
export async function cookieCount(session: Session, origin: string): Promise<number> {
  const { registrable } = displayHost(origin)
  if (!registrable) return 0
  const cookies = await session.cookies.get({ domain: registrable })
  return cookies.filter((c) => cookieInDomain(c, registrable)).length
}

export async function dataList(session: Session): Promise<SiteDataEntry[]> {
  return groupCookies(await session.cookies.get({}))
}

/** The origins worth clearing for a domain: every host with cookies, plus the bare domain, on both schemes. */
function originsFor(domain: string, hosts: readonly string[]): string[] {
  const all = new Set([domain, `www.${domain}`, ...hosts])
  return [...all].flatMap((h) => [`https://${h}`, `http://${h}`])
}

async function removeCookies(session: Session, domain: string): Promise<string[]> {
  const cookies = (await session.cookies.get({ domain })).filter((c) => cookieInDomain(c, domain))
  const hosts = new Set<string>()
  await Promise.all(
    cookies.map((c) => {
      const host = (c.domain ?? '').replace(/^\./, '')
      hosts.add(host)
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`
      return session.cookies.remove(url, c.name).catch(() => undefined)
    }),
  )
  return [...hosts]
}

/** Clears cookies and stored data for a registrable domain and its subdomains (site settings' Clear). */
export async function clearDomainData(session: Session, domain: string): Promise<void> {
  const hosts = await removeCookies(session, domain)
  await session.clearData({ dataTypes: [...DATA_TYPES], origins: originsFor(domain, hosts) })
}

/** Site info's Clear: the site's cookies (by registrable domain, as they are shared) and its stored data. */
export async function clearSiteData(session: Session, origin: string): Promise<void> {
  const { registrable } = displayHost(origin)
  if (registrable) await clearDomainData(session, registrable)
  else await session.clearData({ dataTypes: [...DATA_TYPES], origins: [origin] })
}

/** Clears the cache for one origin, or the whole session's cache. */
export async function clearCache(session: Session, origin?: string): Promise<void> {
  if (!origin) {
    await session.clearCache()
    return
  }
  await session.clearData({ dataTypes: ['cache', 'serviceWorkers'], origins: [origin] })
  await session.clearStorageData({ origin, storages: ['cachestorage', 'shadercache'] }).catch(() => undefined)
}

interface UsageReply {
  usage: number
  usageBreakdown?: { storageType: string; usage: number }[]
}

/**
 * How much the origin stores, split into caches and other data, measured
 * through a tab showing it. Zero when nothing can be measured (no tab, a
 * sign-in page, or the page's debugger is busy).
 */
export async function storageUsage(wc: WebContents | null, origin: string): Promise<{ cacheBytes: number; dataBytes: number }> {
  if (!wc || wc.isDestroyed()) return { cacheBytes: 0, dataBytes: 0 }
  // A sign-in page never gets a DevTools attachment for this (signInHosts.ts).
  if (cdp.onSignInPage(wc)) return { cacheBytes: 0, dataBytes: 0 }
  let release: (() => void) | null = null
  try {
    release = cdp.acquire(wc)
    const reply = await cdp.send<UsageReply>(wc, 'Storage.getUsageAndQuota', { origin })
    let cacheBytes = 0
    let dataBytes = 0
    for (const part of reply.usageBreakdown ?? []) {
      if (part.storageType === 'cookies') continue
      if (CACHE_USAGE.has(part.storageType)) cacheBytes += part.usage
      else dataBytes += part.usage
    }
    return { cacheBytes, dataBytes }
  } catch {
    return { cacheBytes: 0, dataBytes: 0 }
  } finally {
    release?.()
  }
}
