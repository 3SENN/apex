/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { z } from 'zod'
import { WEB_APP_LIMITS, nameFromTitle, pageOfApp, webAppKey, type WebApp } from '@shared/webApps'
import { log } from './log'
import { writeAtomic } from './settings'

// Websites saved as apps (WA-01): the store (userData/web-apps.json,
// schema-checked; an unreadable file starts empty), what a site says about
// itself (its web app manifest's name, start page and icon, else its title,
// meta tags and favicon), and which tab an app's tab is. Everything stays a
// web address; nothing is installed.

export const WEB_APPS_FILE = 'web-apps.json'
/** The isolated world that reads a page's name and icons (999, 1004–1006 and others are taken). */
export const WEB_APPS_WORLD = 1088
const FETCH_TIMEOUT_MS = 6000

const appSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(WEB_APP_LIMITS.name),
  url: z.string().url().max(WEB_APP_LIMITS.url),
  icon: z.string().max(WEB_APP_LIMITS.icon * 2).nullable(),
  addedAt: z.number().finite(),
  lastOpenedAt: z.number().finite().nullable(),
})
const fileSchema = z.object({ version: z.literal(1), apps: z.array(appSchema).max(WEB_APP_LIMITS.apps) })

export class WebAppStore {
  readonly #path: string
  readonly #onChange: (apps: WebApp[]) => void
  readonly #now: () => number
  #apps: WebApp[] = []

  constructor(dataDir: string, onChange: (apps: WebApp[]) => void = () => undefined, now: () => number = Date.now) {
    this.#path = join(dataDir, WEB_APPS_FILE)
    this.#onChange = onChange
    this.#now = now
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.#path, 'utf8')))
      if (parsed.success) this.#apps = parsed.data.apps
      else log.warn('web-apps', 'Your saved apps couldn’t be read; the list starts empty')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('web-apps', 'Your saved apps couldn’t be read; the list starts empty')
    }
  }

  list(): WebApp[] {
    return [...this.#apps]
  }

  get(id: string): WebApp | undefined {
    return this.#apps.find((a) => a.id === id)
  }

  /** The app saved for this address, if any. */
  byUrl(url: string): WebApp | undefined {
    const key = webAppKey(url)
    return key ? this.#apps.find((a) => webAppKey(a.url) === key) : undefined
  }

  add(input: { name: string; url: string; icon: string | null }): WebApp {
    const key = webAppKey(input.url)
    if (!key) throw new Error('Only websites can be saved as apps.')
    const known = this.byUrl(key)
    if (known) return known
    if (this.#apps.length >= WEB_APP_LIMITS.apps) throw new Error(`You can keep up to ${WEB_APP_LIMITS.apps} apps.`)
    const app: WebApp = {
      id: randomUUID(),
      name: input.name.trim().slice(0, WEB_APP_LIMITS.name) || new URL(key).host,
      url: key,
      icon: input.icon && input.icon.length <= WEB_APP_LIMITS.icon * 2 ? input.icon : null,
      addedAt: this.#now(),
      lastOpenedAt: null,
    }
    this.#set([...this.#apps, app])
    return app
  }

  rename(id: string, name: string): WebApp {
    const app = this.get(id)
    if (!app) throw new Error('That app is gone.')
    const next = { ...app, name: name.trim().slice(0, WEB_APP_LIMITS.name) || app.name }
    if (next.name === app.name) return app
    this.#set(this.#apps.map((a) => (a.id === id ? next : a)))
    return next
  }

  remove(id: string): void {
    if (this.get(id)) this.#set(this.#apps.filter((a) => a.id !== id))
  }

  touch(id: string): void {
    const now = this.#now()
    this.#set(this.#apps.map((a) => (a.id === id ? { ...a, lastOpenedAt: now } : a)))
  }

  #set(apps: WebApp[]): void {
    this.#apps = apps
    try {
      writeAtomic(this.#path, `${JSON.stringify({ version: 1, apps }, null, 2)}\n`)
    } catch (err) {
      log.error('web-apps', 'Your saved apps couldn’t be written', { error: err instanceof Error ? err.message : String(err) })
    }
    this.#onChange(this.list())
  }
}

// ── What a site says about itself ──

interface PageInfo {
  manifest: string | null
  appName: string | null
  title: string
  icons: Array<{ href: string; sizes: string; rel: string }>
}

const PAGE_INFO = `(() => {
  const attr = (sel, name) => { const el = document.querySelector(sel); return el ? el.getAttribute(name) : null }
  const link = (sel) => { const el = document.querySelector(sel); return el ? el.href : null }
  const icons = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]')].slice(0, 20).map((l) => ({ href: l.href, sizes: l.getAttribute('sizes') || '', rel: l.rel }))
  return { manifest: link('link[rel="manifest"]'), appName: attr('meta[name="application-name"]', 'content') || attr('meta[name="apple-mobile-web-app-title"]', 'content') || attr('meta[property="og:site_name"]', 'content'), title: document.title || '', icons }
})()`

const manifestSchema = z
  .object({
    name: z.string().max(200).optional(),
    short_name: z.string().max(100).optional(),
    start_url: z.string().max(WEB_APP_LIMITS.url).optional(),
    icons: z.array(z.object({ src: z.string().max(WEB_APP_LIMITS.url), sizes: z.string().max(100).optional(), type: z.string().max(100).optional() }).passthrough()).max(50).optional(),
  })
  .passthrough()

/** The largest side a "sizes" attribute names (0 for "any" or nothing). */
function largest(sizes: string | undefined): number {
  return Math.max(0, ...(sizes ?? '').split(/\s+/).map((s) => Number(/^(\d+)x\d+$/i.exec(s)?.[1] ?? 0)))
}

/** The best icon among candidates: the largest up to 512 px, PNG or SVG first. */
function bestIcon(candidates: Array<{ url: string; size: number; type?: string }>): string | null {
  const usable = candidates.filter((c) => /^https?:/i.test(c.url) && c.size <= 512)
  const score = (c: { size: number; type?: string; url: string }): number => (c.size || 32) + (/png|svg/i.test(c.type ?? c.url) ? 1000 : 0)
  return usable.sort((a, b) => score(b) - score(a))[0]?.url ?? null
}

async function fetchWith(session: Session, url: string): Promise<Response | null> {
  try {
    const res = await session.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    return res.ok ? res : null
  } catch {
    return null
  }
}

/** An image as a data URL (images only, up to the icon limit), or null. */
export async function iconData(session: Session, url: string | null): Promise<string | null> {
  if (!url) return null
  const res = await fetchWith(session, url)
  const type = res?.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!res || !type.startsWith('image/')) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0 || bytes.length > WEB_APP_LIMITS.icon) return null
  return `data:${type};base64,${bytes.toString('base64')}`
}

/** What a tab's site says about itself as an app: its name, where it starts, and its icon. */
export async function siteAsApp(wc: WebContents, favicon: string | null): Promise<{ name: string; url: string; icon: string | null }> {
  const pageUrl = wc.getURL()
  const host = new URL(pageUrl).host
  let info: PageInfo = { manifest: null, appName: null, title: wc.getTitle(), icons: [] }
  try {
    info = (await wc.executeJavaScriptInIsolatedWorld(WEB_APPS_WORLD, [{ code: PAGE_INFO }])) as PageInfo
  } catch {
    // A page that won't run the reader still saves, with its title and favicon.
  }
  let name: string | null = null
  let url = pageUrl
  const candidates: Array<{ url: string; size: number; type?: string }> = []
  if (info.manifest) {
    const res = await fetchWith(wc.session, info.manifest)
    const manifest = res ? manifestSchema.safeParse(await res.json().catch(() => null)) : null
    if (manifest?.success) {
      name = manifest.data.short_name?.trim() || manifest.data.name?.trim() || null
      const start = manifest.data.start_url ? new URL(manifest.data.start_url, info.manifest) : null
      if (start && start.origin === new URL(pageUrl).origin) url = start.href
      for (const i of manifest.data.icons ?? []) candidates.push({ url: new URL(i.src, info.manifest).href, size: largest(i.sizes), ...(i.type ? { type: i.type } : {}) })
    }
  }
  for (const i of info.icons) candidates.push({ url: i.href, size: largest(i.sizes) || (i.rel.includes('apple') ? 180 : 0) })
  if (favicon) candidates.push({ url: favicon, size: 16 })
  const icon = (await iconData(wc.session, bestIcon(candidates))) ?? (await iconData(wc.session, favicon))
  return { name: (name ?? info.appName?.trim() ?? nameFromTitle(info.title, host)).slice(0, WEB_APP_LIMITS.name) || host, url, icon }
}

// ── Opening: the feature sets the opener; the command bar and window services call it ──

let opener: ((win: import('./features/types').WindowContext | null, id: string) => void) | null = null

export function setWebAppOpener(fn: typeof opener): void {
  opener = fn
}

/** Opens a saved app from `win` (back to its tab, else a new one). False when apps aren't running. */
export function openWebApp(win: import('./features/types').WindowContext | null, id: string): boolean {
  if (!opener) return false
  opener(win, id)
  return true
}

// ── Which tab is an app's tab ──

export interface AppTabs<W> {
  /** Windows, the asking one first. */
  windows(): readonly W[]
  tabs(win: W): ReadonlyArray<{ id: string; url: string }>
}

/**
 * Where an app's tab is: the tab it last opened when that one is still on
 * the app, else any tab under its address (anywhere on its site when no
 * other app shares the site), the asking window's first. Null opens a new one.
 */
export function findAppTab<W>(app: WebApp, all: readonly WebApp[], last: string | null, where: AppTabs<W>): { win: W; tabId: string } | null {
  const host = (u: string): string => {
    try {
      return new URL(u).host
    } catch {
      return ''
    }
  }
  const wholeSite = all.filter((a) => host(a.url) === host(app.url)).length === 1
  const wins = where.windows()
  if (last) {
    for (const win of wins) {
      const tab = where.tabs(win).find((t) => t.id === last)
      if (tab && pageOfApp(tab.url, app.url, wholeSite)) return { win, tabId: tab.id }
    }
  }
  for (const win of wins) {
    const tab = where.tabs(win).find((t) => pageOfApp(t.url, app.url, wholeSite))
    if (tab) return { win, tabId: tab.id }
  }
  return null
}
