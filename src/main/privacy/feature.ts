/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { net, type OnHeadersReceivedListenerDetails, type Session, type WebContents } from 'electron'
import type { Settings } from '@shared/ipc'
import type { CookieBannerState, CookieListId, PrivacyExceptionKind, PrivacyExceptions, PrivacySummary } from '@shared/privacyPack'
import { isSignInUrl } from '@shared/signInHosts'
import { adBlocker, onRequestBlocked } from '../adblock'
import { isWebPartition } from '../features/sitesSafety'
import type { AppContext, Feature } from '../features/types'
import { log } from '../log'
import { profileDataDir } from '../profiles/paths'
import { sites } from '../sites'
import type { Tab } from '../tabs'
import { webRequestHooks, type WebRequestHooks } from '../webRequest'
import { bannerScript, bundledCss, buildCss, isBannerResult } from './cookieBanners'
import { CookieLists, LIST_MAX_BYTES } from './cookieLists'
import { privacyExceptions } from './exceptions'
import { hostKey, httpsUpgrades } from './httpsFirst'

// The privacy pack's wiring (Settings › Privacy, the site info popover):
// - HTTPS-First as a registered layer of the webRequest mux on every web
//   session: top-level http requests of tabs go to https first; sitesSafety's
//   did-fail-load asks httpsUpgrades whether a failure was a failed upgrade
//   and shows the https-unavailable page at the http address.
// - Cookie banners on each tab's page at dom-ready: Apex's own stylesheet plus
//   the enabled downloaded lists' rules as injected stylesheets, and the reject
//   script in its own isolated world.
// - The per-page counts and states the site info summary reads.

/** The reject script's isolated world (others: 999 preload, 1004 pip, 1005 media, 1006 forms, 1051 read, 1077 probe). */
export const COOKIE_WORLD = 1033
const PROFILE_PARTITION = /^persist:apex-profile-(.+)$/
const DAY = 24 * 60 * 60 * 1000

interface PageState {
  /** Bumped on every commit, so a late script answer for an older page is dropped. */
  generation: number
  /** Bumped on every apply, so a stylesheet that lands after a newer apply is taken out again. */
  apply: number
  trackers: number
  banner: CookieBannerState
  cssKeys: string[]
}

type PackSettings = Pick<Settings, 'httpsFirst' | 'hideCookieBanners' | 'cookieBannerLists' | 'adblock'>

function headerValue(headers: Record<string, string[]> | undefined, name: string): string | null {
  if (!headers) return null
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value[0] ?? null
  return null
}

function webHost(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? hostKey(u.hostname) : null
  } catch {
    return null
  }
}

async function fetchList(url: string): Promise<string> {
  const res = await net.fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > LIST_MAX_BYTES) throw new Error('The list is too large.')
  return res.text()
}

export function createPrivacyPackFeature(): Feature {
  let ctx: AppContext | null = null
  let lists: CookieLists | null = null
  const pages = new Map<number, PageState>()
  const stops: (() => void)[] = []
  const BUNDLED_CSS = bundledCss()
  const SCRIPT = bannerScript()

  const settings = (): PackSettings => {
    const s = ctx?.settings.get()
    return { httpsFirst: s?.httpsFirst ?? true, hideCookieBanners: s?.hideCookieBanners ?? true, cookieBannerLists: s?.cookieBannerLists ?? [], adblock: s?.adblock ?? true }
  }
  const page = (wc: WebContents): PageState => {
    let p = pages.get(wc.id)
    if (!p) {
      p = { generation: 0, apply: 0, trackers: 0, banner: 'none', cssKeys: [] }
      pages.set(wc.id, p)
    }
    return p
  }
  const tabWebContents = (): WebContents[] => (ctx?.tabsRegistry.all() ?? []).map((t) => t.view.webContents).filter((wc) => !wc.isDestroyed())

  // ---- HTTPS-First ----

  const httpsLayer = (session: Session): WebRequestHooks => ({
    onBeforeRequest(d) {
      if (d.resourceType !== 'mainFrame' || d.webContentsId === undefined) return null
      if (!ctx?.tabsRegistry.byWebContents(d.webContentsId)) return null
      const store = privacyExceptions.storeFor(session)
      return httpsUpgrades.beforeRequest(d.webContentsId, d.url, { enabled: settings().httpsFirst, isAllowed: (h) => store?.has('https', h) ?? false })
    },
    onHeadersReceived(d: OnHeadersReceivedListenerDetails) {
      if (d.resourceType !== 'mainFrame' || d.webContentsId === undefined) return null
      httpsUpgrades.headersReceived(d.webContentsId, d.url, d.statusCode, headerValue(d.responseHeaders, 'location'))
      return null
    },
  })

  // ---- cookie banners ----

  const removeCss = (wc: WebContents, p: PageState): void => {
    for (const key of p.cssKeys.splice(0)) void wc.removeInsertedCSS(key).catch(() => undefined)
  }

  const applyBanners = (wc: WebContents): void => {
    if (wc.isDestroyed()) return
    const p = page(wc)
    const url = wc.getURL()
    const host = webHost(url)
    const applyId = ++p.apply
    removeCss(wc, p)
    if (!settings().hideCookieBanners) {
      p.banner = 'off'
      return
    }
    if (!host || isSignInUrl(url)) {
      p.banner = 'none'
      return
    }
    if (privacyExceptions.storeFor(wc.session)?.has('cookieBanners', host)) {
      p.banner = 'allowed'
      return
    }
    const generation = p.generation
    const sheets = [BUNDLED_CSS, buildCss(lists?.selectors(settings().cookieBannerLists, host) ?? [])].filter(Boolean)
    for (const css of sheets) {
      void wc
        // Author origin: Electron can take an injected sheet out again only at that origin, and the per-site switch does so live.
        .insertCSS(css, { cssOrigin: 'author' })
        .then((key) => {
          if (wc.isDestroyed()) return
          const now = page(wc)
          if (now.generation === generation && now.apply === applyId) now.cssKeys.push(key)
          else void wc.removeInsertedCSS(key).catch(() => undefined)
        })
        .catch(() => undefined)
    }
    p.banner = 'checking'
    void wc
      .executeJavaScriptInIsolatedWorld(COOKIE_WORLD, [{ code: SCRIPT }])
      .then((result: unknown) => {
        if (wc.isDestroyed()) return
        const now = page(wc)
        if (now.generation !== generation || now.banner !== 'checking') return
        now.banner = isBannerResult(result) ? (result.rejected ? 'rejected' : result.found ? 'hidden' : 'none') : 'none'
      })
      .catch(() => {
        if (!wc.isDestroyed() && page(wc).generation === generation && page(wc).banner === 'checking') page(wc).banner = 'none'
      })
  }

  /** Every open page of a host in a session (or all pages) follows a change at once. */
  const reapply = (filter: (wc: WebContents) => boolean = () => true): void => {
    for (const wc of tabWebContents()) if (filter(wc)) applyBanners(wc)
  }

  // ---- the summary ----

  const summary = (tabId: string): PrivacySummary | null => {
    const tab = ctx?.tabsRegistry.get(tabId)
    const wc = tab?.view.webContents
    if (!tab || !wc || wc.isDestroyed() || tab.internalUrl) return null
    const url = wc.getURL()
    const host = webHost(url)
    if (!host) return null
    const https = /^https:/i.test(url)
    const allowed = privacyExceptions.storeFor(wc.session)?.has('https', host) ?? false
    const origin = new URL(url).origin
    const rule = sites.settingsFor(wc.session, origin).adblock
    const blocker = adBlocker()
    const blocking = blocker !== null && (rule === 'block' || (rule === 'default' && blocker.enabled))
    const p = pages.get(wc.id)
    return {
      host,
      connection: https ? (httpsUpgrades.wasUpgraded(wc.id, url) ? 'upgraded' : 'https') : allowed ? 'http-allowed' : 'http',
      trackersBlocked: p?.trackers ?? 0,
      blocking,
      cookieBanner: settings().hideCookieBanners ? (p?.banner ?? 'none') : 'off',
    }
  }

  const exceptionsOf = (session: Session): PrivacyExceptions => privacyExceptions.storeFor(session)?.list() ?? { https: [], cookieBanners: [] }

  return {
    name: 'privacyPack',
    app(app) {
      ctx = app
      lists = new CookieLists({
        dir: join(app.dataDir, 'cookie-lists'),
        // Smoke runs never leave the machine.
        fetchText: app.smoke ? () => Promise.reject(new Error('No downloads in smoke runs.')) : fetchList,
        onChange: () => reapply(),
      })
      const ensure = (ids: readonly CookieListId[]): void => {
        void lists?.ensure(ids, { download: !app.smoke }).catch((err: unknown) => log.warn('privacy', 'Loading cookie lists failed', { error: err instanceof Error ? err.message : String(err) }))
      }
      ensure(settings().cookieBannerLists)
      const timer = setInterval(() => ensure(settings().cookieBannerLists), DAY)
      timer.unref?.()
      stops.push(() => clearInterval(timer))
      const onSettings = (next: Settings, previous: Settings): void => {
        if (next.hideCookieBanners !== previous.hideCookieBanners) reapply()
        if (JSON.stringify(next.cookieBannerLists) !== JSON.stringify(previous.cookieBannerLists)) {
          ensure(next.cookieBannerLists)
          reapply()
        }
      }
      app.settings.on('changed', onSettings)
      stops.push(() => app.settings.off('changed', onSettings))
      stops.push(
        onRequestBlocked((webContentsId) => {
          if (webContentsId === undefined) return
          const p = pages.get(webContentsId)
          if (p) p.trackers++
        }),
      )
    },
    session(session, info) {
      if (!isWebPartition(info.partition)) return
      const profileId = PROFILE_PARTITION.exec(info.partition)?.[1]
      const dataDir = ctx ? (profileId ? profileDataDir(ctx.dataDir, profileId) : ctx.dataDir) : ''
      privacyExceptions.attach(session, { private: info.private || !ctx, dataDir })
      stops.push(webRequestHooks.add(httpsLayer(session), { sessions: [session] }))
    },
    window(win) {
      return {
        privacy: {
          summary: async (tabId: string) => summary(tabId),
          exceptions: async () => exceptionsOf(win.session),
          setException: async (kind: PrivacyExceptionKind, host: string, on: boolean) => {
            const store = privacyExceptions.storeFor(win.session)
            if (!store) throw new Error('This window has no profile to save that in.')
            store.set(kind, host, on)
            const key = hostKey(host)
            if (kind === 'cookieBanners') reapply((wc) => wc.session === win.session && webHost(wc.getURL()) === key)
            return exceptionsOf(win.session)
          },
          cookieLists: async () => lists?.status(settings().cookieBannerLists) ?? [],
          updateCookieLists: async () => {
            const enabled = settings().cookieBannerLists
            if (lists && !ctx?.smoke) await lists.update(enabled)
            return lists?.status(enabled) ?? []
          },
        },
      }
    },
    tab(tab: Tab) {
      const wc = tab.view.webContents
      const id = wc.id
      page(wc)
      const onStart = (details: { isMainFrame: boolean; isSameDocument?: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) httpsUpgrades.started(id)
      }
      const onNavigate = (_event: unknown, url: string): void => {
        httpsUpgrades.committed(id, url)
        const p = page(wc)
        p.generation++
        p.trackers = 0
        p.banner = 'none'
        p.cssKeys = []
      }
      const onDomReady = (): void => applyBanners(wc)
      wc.on('did-start-navigation', onStart)
      wc.on('did-navigate', onNavigate)
      wc.on('dom-ready', onDomReady)
      return () => {
        httpsUpgrades.forget(id)
        pages.delete(id)
        if (wc.isDestroyed()) return
        wc.off('did-start-navigation', onStart)
        wc.off('did-navigate', onNavigate)
        wc.off('dom-ready', onDomReady)
      }
    },
    dispose() {
      for (const stop of stops.splice(0)) stop()
    },
  }
}
