/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ElectronBlocker, fromElectronDetails, type NetworkFilter } from '@ghostery/adblocker-electron'
import type { InsertCSSOptions, IpcMainInvokeEvent, OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails, Session, CallbackResponse, HeadersReceivedResponse } from 'electron'
import type { SiteToggle } from '@shared/sites'
import { log } from './log'
import { blockedNavigations } from './navErrors'
import type { WebRequestHooks } from './webRequest'

/**
 * Ghostery's ad and tracker blocker. The compiled engine is cached on disk so
 * later launches work offline. Its network filtering runs as the first layer
 * of the webRequest mux (never enableBlockingInSession, which would take
 * over the session's only webRequest listeners); cosmetic filtering still uses
 * Ghostery's frame preload. A site with ad blocking set to allow (ST-35)
 * is skipped for its pages and everything they load.
 */
export class AdBlocker {
  readonly #cachePath: string
  #blocker: ElectronBlocker | null = null
  #loading: Promise<ElectronBlocker> | null = null
  #enabled = false
  readonly #cosmetic = new WeakSet<Session>()
  #siteRule: (session: Session | null, pageUrl: string) => SiteToggle = () => 'default'

  constructor(dataDir: string) {
    this.#cachePath = join(dataDir, 'adblock-engine.bin')
    current = this
  }

  get enabled(): boolean {
    return this.#enabled && this.#blocker !== null
  }

  /** The per-site switch (the site store), consulted for every page: allow skips it, block blocks even with the global switch off. */
  setSiteRule(fn: (session: Session | null, pageUrl: string) => SiteToggle): void {
    this.#siteRule = fn
  }

  /** Whether a page (and what it loads) is filtered. */
  #active(session: Session | null, page: string | null): boolean {
    if (!this.#blocker) return false
    const rule = page ? this.#siteRule(session, page) : 'default'
    return rule === 'block' || (rule === 'default' && this.#enabled)
  }

  /** On or off for every session; the session given gets cosmetic filtering when turned on. */
  async setEnabled(session: Session, enabled: boolean): Promise<void> {
    if (enabled) {
      const blocker = await this.#load()
      this.#enabled = true
      this.#installCosmetics(session, blocker)
    } else {
      this.#enabled = false
    }
  }

  /** Cosmetic filtering for another session (private windows, profiles) once the engine is loaded. */
  addSession(session: Session): void {
    if (this.#enabled && this.#blocker) this.#installCosmetics(session, this.#blocker)
  }

  /** The mux layer. Main frames are refused only for whole-site filters (strict blocking), so the tab can say why. */
  layer(session: Session, topUrl: (d: { webContents?: Electron.WebContents; resourceType: string; url: string }) => string | null): WebRequestHooks {
    return {
      onBeforeRequest: (d: OnBeforeRequestListenerDetails): CallbackResponse | null => {
        const blocker = this.#blocker
        const page = d.resourceType === 'mainFrame' ? d.url : topUrl(d)
        if (!blocker || !this.#active(session, page)) return null
        if (d.resourceType === 'mainFrame') {
          if (!strictBlock(blocker, d)) return null
          if (d.webContentsId !== undefined) blockedNavigations.note(d.webContentsId, d.url, 'adblock')
          return { cancel: true }
        }
        let out: CallbackResponse | null = null
        blocker.onBeforeRequest(d, (r) => {
          out = r
        })
        // ── privacy pack: blocked-request count ──
        const result = out as CallbackResponse | null
        if (result && (result.cancel || result.redirectURL)) noteBlocked(d.webContentsId, d.url)
        return out
      },
      onHeadersReceived: (d: OnHeadersReceivedListenerDetails): HeadersReceivedResponse | null => {
        const blocker = this.#blocker
        const page = d.resourceType === 'mainFrame' ? d.url : topUrl(d)
        if (!blocker || !this.#active(session, page)) return null
        let out: HeadersReceivedResponse | null = null
        blocker.onHeadersReceived(d, (r) => {
          out = r.responseHeaders ? r : null
        })
        return out
      },
    }
  }

  #installCosmetics(session: Session, blocker: ElectronBlocker): void {
    if (this.#cosmetic.has(session)) return
    this.#cosmetic.add(session)
    // Ghostery's own context registers its frame preload and IPC handlers; with
    // network filters switched off for that call it leaves webRequest to the mux.
    const config = blocker.config as { loadNetworkFilters: boolean }
    const network = config.loadNetworkFilters
    try {
      config.loadNetworkFilters = false
      blocker.enableBlockingInSession(session)
    } catch (err) {
      // A second session finds the IPC handlers already there; its preload is registered all the same.
      log.debug('adblock', 'Cosmetic filtering setup', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      config.loadNetworkFilters = network
    }
  }

  #load(): Promise<ElectronBlocker> {
    if (this.#blocker) return Promise.resolve(this.#blocker)
    this.#loading ??= ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: this.#cachePath,
      read: async (path) => new Uint8Array(await readFile(path)),
      write: (path, buffer) => writeFile(path, buffer),
    }).then((blocker) => {
      this.#wrapCosmetics(blocker)
      this.#blocker = blocker
      return blocker
    }).finally(() => {
      this.#loading = null
    })
    return this.#loading
  }

  /** Cosmetic rules stay off on allowed sites and while blocking is switched off. */
  #wrapCosmetics(blocker: ElectronBlocker): void {
    const inject = blocker.onInjectCosmeticFilters
    blocker.onInjectCosmeticFilters = async (event: IpcMainInvokeEvent, url: string, msg?: Parameters<typeof inject>[2]) => {
      if (!this.#active(event.sender.session, url)) return
      return inject(settledEvent(event), url, msg)
    }
  }
}

/**
 * Ghostery injects a page's styles and scriptlets without waiting on them, so
 * a scriptlet that throws in the page (or a tab that closes first) was an
 * unhandled rejection in main, "Script failed to execute", a few per page.
 * Its handler gets a sender whose two calls settle on their own; everything
 * else it reads (frameId, processId) is the real event's.
 */
export function settledEvent(event: IpcMainInvokeEvent): IpcMainInvokeEvent {
  const wc = event.sender
  const sender = {
    insertCSS: (css: string, options?: InsertCSSOptions): Promise<string> => wc.insertCSS(css, options).catch(() => ''),
    executeJavaScript: (code: string, userGesture?: boolean): Promise<unknown> => wc.executeJavaScript(code, userGesture).catch(() => undefined),
  }
  return Object.create(event, { sender: { value: sender } }) as IpcMainInvokeEvent
}

let current: AdBlocker | null = null

// ── privacy pack: blocked-request listeners ── (the site info popover's count, src/main/privacy/feature.ts)
type BlockedListener = (webContentsId: number | undefined, url: string) => void
const blockedListeners = new Set<BlockedListener>()

/** Told of each request the blocker stops or replaces (not whole pages refused by strict blocking). */
export function onRequestBlocked(fn: BlockedListener): () => void {
  blockedListeners.add(fn)
  return () => blockedListeners.delete(fn)
}

function noteBlocked(webContentsId: number | undefined, url: string): void {
  for (const fn of blockedListeners) {
    try {
      fn(webContentsId, url)
    } catch {
      // A listener's failure never stalls a request.
    }
  }
}

/** The app's blocker (index.ts creates it); the mux reads it per request, so it can arrive after the sessions. */
export function adBlocker(): AdBlocker | null {
  return current
}

/**
 * Strict blocking: a whole page is refused only when a filter names its whole
 * site (||ads.example^) or explicitly targets documents ($document), the way
 * blockers warn before opening a known ad or tracking domain. Filters with a
 * path never block a page you open.
 */
export function strictBlock(blocker: Pick<ElectronBlocker, 'match'>, d: Pick<OnBeforeRequestListenerDetails, 'url' | 'resourceType' | 'referrer' | 'id'> & { webContentsId?: number }): boolean {
  const request = fromElectronDetails(d as OnBeforeRequestListenerDetails)
  const { match, filter, exception } = blocker.match(request)
  if (!match || exception || !filter) return false
  return isWholeSiteFilter(filter)
}

export function isWholeSiteFilter(filter: NetworkFilter): boolean {
  if (filter.isException() || filter.isRedirect() || filter.isCSP()) return false
  if (filter.fromDocument() && !filter.fromAny()) return true
  return filter.isHostnameAnchor() && !filter.hasFilter() && !filter.hasDomains()
}
