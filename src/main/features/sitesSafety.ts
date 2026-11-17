/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { join } from 'node:path'
import { app as electronApp, ipcMain, net, type Event, type Session, type WebContents, type WebContentsWillNavigateEventParams } from 'electron'
import { PAGE, type PageConfig, type ProxySettings, type Settings, type TabInfo } from '@shared/ipc'
import { toProxyConfig } from '@shared/proxy'
import { AUTO_RETRY_KINDS, hostOfUrl, netErrorName, type PageErrorDetails, type PageNoticeProps } from '@shared/safety'
import type { SiteServices } from '@shared/services/sites'
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '@shared/sites'
import { adBlocker } from '../adblock'
import { certificateDecisions, certificateDetails, installCertificateRecorder, pendingCertificates } from '../certificates'
import { log } from '../log'
import { blockedNavigations, PageErrorTracker } from '../navErrors'
import { network, startNetworkWatch, type NetworkWatch } from '../network'
import { closePageNotice, showPageNotice } from '../pageNotices'
import { BlockedOnPage, downloadBlocked, gestures, isGestureInput, popupDecision, redirectBlocked } from '../popupBlocker'
import { registerPopupPolicy } from '../popupPolicy'
import { clearOnExit, originOf, privacyLayer, wantsClearOnExit } from '../privacy'
import { installChromeSurface } from '../chromeSurface'
import { installClientHints } from '../clientHints'
import { installSignInIdentity, isFirefoxRequest } from '../signInIdentity'
import { identity } from '../userAgent'
import { safety, safetyLayer } from '../safety'
import { privacyExceptions } from '../privacy/exceptions' // privacy pack
import { httpsUpgrades } from '../privacy/httpsFirst' // privacy pack
import { contentLayer } from '../siteContent'
import { sites } from '../sites'
import { storageCategories } from '../storage'
import type { Tab } from '../tabs'
import { installWebRequestMux, type WebRequestHooks } from '../webRequest'
import type { AppContext, Feature, ServiceParts, SessionInfo, WindowContext } from './types'

// The site safety wiring (SS-06, SS-07, ST-35): the webRequest mux,
// certificates, error pages, the online state, pop-ups, privacy and the
// proxy. sitesFeature (sites.ts) calls into it.
// app() only builds closures, so the schema tests can call it with a bare
// context; everything that listens starts with the first real session.

/** A pack's partition (docs/packs.md): its sandbox sets its own dead-end proxy, which the proxy setting never replaces. */
export function isPackPartition(partition: string): boolean {
  return /^(persist:atelier-pack-|atelier-pack-test-)/.test(partition)
}

/** Sandbox partitions are locked down, never browsed: they get the mux but none of the browsing layers. */
export function isWebPartition(partition: string): boolean {
  return !/^(atelier-preprocess|atelier-artifacts)$/.test(partition) && !/^persist:atelier-app-/.test(partition) && !isPackPartition(partition)
}

interface TabEntry {
  tab: Tab
  win: WindowContext
  tracker: PageErrorTracker
  /** Downloads this page started (automatic downloads). */
  downloads: number
  /** The last download the site was refused, for Allow once. */
  blockedDownload: string | null
  /** A frame redirect waiting on the notice. */
  blockedRedirect: string | null
}

type PrivacyCache = Pick<Settings, 'blockThirdPartyCookies' | 'globalPrivacyControl' | 'clearOnExit' | 'proxy' | 'popupBlocking' | 'adblock'>

export interface SafetyRuntime {
  services: Pick<SiteServices, 'pageErrors'> & { network: Pick<SiteServices['network'], 'check'> }
  session(session: Session, info: SessionInfo): void
  window(win: WindowContext): void
  tab(tab: Tab, win: WindowContext): () => void
  dispose(): void
}

export function createSafety(app: AppContext): SafetyRuntime {
  const entries = new Map<string, TabEntry>()
  const byWebContents = new Map<number, TabEntry>()
  const sessions = new Set<Session>()
  const webSessions = new WeakSet<Session>()
  const blockedPopups = new BlockedOnPage()
  const adblockAllowed = new Map<Session, Set<string>>()
  let cfg: PrivacyCache | null = null
  let watch: NetworkWatch | null = null
  let started = false
  // Removed only by an explicit dispose(); quitting can still be cancelled, so before-quit leaves them in place.
  const stops: (() => void)[] = []

  const settings = (): PrivacyCache => {
    cfg ??= pick(app.settings.get())
    return cfg
  }
  const siteRules = (session: Session | null | undefined, origin: string): SiteSettings => {
    try {
      return sites.settingsFor(session, origin)
    } catch {
      return DEFAULT_SITE_SETTINGS
    }
  }
  const setSite = (session: Session, origin: string, patch: Partial<SiteSettings>): void => {
    const store = sites.storeFor(session)
    if (store) store.set(origin, patch)
    else if (patch.adblock === 'allow') {
      // No site store yet (the sites feature not attached): the exception lasts the session.
      const set = adblockAllowed.get(session) ?? new Set<string>()
      set.add(origin)
      adblockAllowed.set(session, set)
    }
  }
  const topUrl = (d: { webContents?: WebContents; resourceType: string; url: string }): string | null => {
    if (d.resourceType === 'mainFrame') return d.url
    const wc = d.webContents
    if (!wc || wc.isDestroyed()) return null
    return wc.getURL() || null
  }

  // ---- tabs ----

  const entryOf = (tabId: string): TabEntry => {
    const e = entries.get(tabId)
    if (!e || e.tab.view.webContents.isDestroyed()) throw new Error('That tab is closed.')
    return e
  }
  const changed = (e: TabEntry): void => e.win.tabs.recover()
  const decorate = (tab: Tab): Partial<TabInfo> => {
    const e = entries.get(tab.id)
    if (!e || tab.internalUrl) return {}
    const s = e.tracker.state()
    const out: Partial<TabInfo> = { pageError: s.error, crashed: s.crashed, unresponsive: s.unresponsive }
    const wc = tab.view.webContents
    if (wc.isDestroyed()) return out
    const host = hostOfUrl(s.error?.url ?? wc.getURL())
    // Privacy pack: the HTTPS-First page is about an unencrypted site, so the pill shows no lock.
    if (s.error?.kind === 'certificate' || s.error?.kind === 'https-unavailable') out.security = 'insecure'
    else if (s.error?.kind === 'dangerous-site' || (host && safety.isBypassed(wc.session, host))) out.security = 'dangerous'
    else if (sites.hasCertificateException(tab.id)) out.security = 'cert-bypassed'
    return out
  }

  const notice = (e: TabEntry, kind: PageNoticeProps['kind'], target: string, count: number): void => {
    const wc = e.tab.view.webContents
    const host = hostOfUrl(wc.getURL())
    void showPageNotice(e.win, { tabId: e.tab.id, kind, host, target, count }).then((answer) => {
      if (answer && !wc.isDestroyed()) act(e, kind, answer)
    })
  }

  const act = (e: TabEntry, kind: PageNoticeProps['kind'], answer: string): void => {
    const wc = e.tab.view.webContents
    const origin = originOf(wc.getURL())
    if (kind === 'unresponsive') {
      if (answer === 'reload') reloadHung(wc)
      return
    }
    if (answer === 'always' && origin) setSite(wc.session, origin, kind === 'downloads' ? { automaticDownloads: 'allow' } : { popups: 'allow' })
    if (kind === 'popup') for (const url of blockedPopups.take(e.tab.id)) e.win.tabs.create(url, { afterId: e.tab.id })
    if (kind === 'redirect' && e.blockedRedirect) {
      const target = e.blockedRedirect
      e.blockedRedirect = null
      void wc.loadURL(target).catch(() => undefined)
    }
    if (kind === 'downloads' && e.blockedDownload) {
      const url = e.blockedDownload
      e.blockedDownload = null
      e.downloads = 0
      wc.downloadURL(url)
    }
  }

  /** A hung renderer won't reload on request; ending it first lets the reload start a fresh one. */
  const reloadHung = (wc: WebContents): void => {
    try {
      wc.forcefullyCrashRenderer()
    } catch {
      // Already gone.
    }
    wc.reload()
  }

  // ---- sessions ----

  const applyProxy = (s: Session, proxy: ProxySettings): void => {
    const config = toProxyConfig(proxy)
    if (!config) log.warn('network', 'Proxy settings are not valid; using the system proxy', { mode: proxy.mode })
    void s
      .setProxy(config ?? { mode: 'system' })
      .then(() => s.closeAllConnections())
      .catch((err: unknown) => log.warn('network', 'Applying the proxy failed', { error: err instanceof Error ? err.message : String(err) }))
  }

  const installSession = (s: Session, info: SessionInfo): void => {
    const web = isWebPartition(info.partition)
    sessions.add(s)
    // The blocker can arrive after the session; its layer is made once, on first use.
    let ad: WebRequestHooks | null = null
    const adLayer = (): WebRequestHooks | null => (ad ??= adBlocker()?.layer(s, topUrl) ?? null)
    installWebRequestMux(s, web, {
      safety: safetyLayer(s),
      adblock: {
        onBeforeRequest: (d) => adLayer()?.onBeforeRequest?.(d) ?? null,
        onHeadersReceived: (d) => adLayer()?.onHeadersReceived?.(d) ?? null,
      },
      privacy: privacyLayer({
        config: () => settings(),
        topUrl,
        cookieRule: (origin) => siteRules(s, origin).cookies,
      }),
      content: contentLayer({ rules: (origin) => siteRules(s, origin), topUrl }),
    })
    if (isPackPartition(info.partition)) {
      sessions.delete(s)
      return
    }
    applyProxy(s, settings().proxy)
    if (!web) return
    webSessions.add(s)
    // Sign-in compatibility: the client hints Electron leaves off navigations, frames and workers,
    // except on pages that present Firefox (Google's sign-in, as an experiment), whose layer runs after and strips them.
    installClientHints(s, { identity, topUrl, exempt: (d) => isFirefoxRequest(d, topUrl) })
    installSignInIdentity(s, { topUrl })
    // window.chrome as stock Chrome fills it, in every frame, sign-in pages and popups included.
    installChromeSurface(s, join(__dirname, '../preload/chromeSurface.js'))
    installCertificateRecorder(s)
    adBlocker()?.addSession(s)
    s.on('will-download', (_event, item, wc) => {
      const e = wc ? byWebContents.get(wc.id) : undefined
      if (!e) return
      const origin = originOf(wc.getURL())
      const rule = origin ? siteRules(s, origin).automaticDownloads : 'default'
      if (downloadBlocked({ siteRule: rule, downloadsThisPage: e.downloads, userGesture: gestures.had(wc.id) })) {
        e.blockedDownload = item.getURL()
        item.cancel()
        notice(e, 'downloads', '', e.downloads + 1)
        return
      }
      e.downloads++
    })
  }

  // ---- what starts with the first session ----

  const start = (): void => {
    if (started) return
    started = true
    cfg = pick(app.settings.get())
    const onSettings = (next: Settings, previous: Settings): void => {
      cfg = pick(next)
      if (JSON.stringify(next.proxy) !== JSON.stringify(previous.proxy)) for (const s of sessions) applyProxy(s, next.proxy)
    }
    app.settings.on('changed', onSettings)
    stops.push(() => app.settings.off('changed', onSettings))

    // The ad blocker skips sites set to allow; before the site store exists, the session's own exceptions count.
    adBlocker()?.setSiteRule((s, pageUrl) => {
      const origin = originOf(pageUrl)
      if (!origin) return 'default'
      if (s !== null && adblockAllowed.get(s)?.has(origin)) return 'allow'
      return siteRules(s, origin).adblock
    })

    // The certificate interstitial: a decision for this host and certificate lets it through; anything else is refused and remembered for the page.
    const onCertificateError = (event: Event, wc: WebContents, url: string, error: string, certificate: Electron.Certificate, callback: (trusted: boolean) => void, isMainFrame: boolean): void => {
      event.preventDefault()
      const host = hostOfUrl(url)
      if (host && certificateDecisions(wc.session).isAllowed(host, certificate.fingerprint)) {
        callback(true)
        return
      }
      if (isMainFrame) pendingCertificates.set(wc.id, { host, fingerprint: certificate.fingerprint, error, details: certificateDetails(certificate) })
      callback(false)
    }
    electronApp.on('certificate-error', onCertificateError)
    stops.push(() => electronApp.off('certificate-error', onCertificateError))

    // PAGE.config: the page preload asks before any page script runs; only browsing pages get an answer.
    const onConfig = (event: Electron.IpcMainEvent): void => {
      const answer: PageConfig | null = webSessions.has(event.sender.session) ? { gpc: settings().globalPrivacyControl } : null
      event.returnValue = answer
    }
    ipcMain.on(PAGE.config, onConfig)
    stops.push(() => ipcMain.off(PAGE.config, onConfig))

    // Pop-ups: asked by popups.ts before any window opens.
    stops.push(
      registerPopupPolicy((d) => {
        const wc = d.tab.view.webContents
        const origin = originOf(wc.getURL())
        const decision = popupDecision({ blockingOn: settings().popupBlocking, siteRule: origin ? siteRules(wc.session, origin).popups : 'default', userGesture: d.userGesture })
        const e = entries.get(d.tab.id)
        if (decision === 'block' && e) notice(e, 'popup', d.url, blockedPopups.add(d.tab.id, d.url))
        return decision
      }),
    )

    // The online state (SS-06): offline error pages reload when it returns.
    watch = startNetworkWatch({
      isOnline: () => net.isOnline(),
      probe: app.smoke ? undefined : () => net.resolveHost('example.com', { cacheUsage: 'disallowed' }).then((r) => r.endpoints.length > 0),
    })
    stops.push(() => watch?.stop())
    stops.push(
      network.onChange((online) => {
        if (!online) return
        for (const e of entries.values()) {
          const kind = e.tracker.state().error?.kind
          if (kind && AUTO_RETRY_KINDS.has(kind) && !e.tab.view.webContents.isDestroyed()) e.tab.view.webContents.reload()
        }
      }),
    )

    // Clear on exit: quitting waits for the wipe, at most a few seconds.
    let clearing = false
    let cleared = false
    const onWillQuit = (event: Event): void => {
      const what = settings().clearOnExit
      if (cleared || !wantsClearOnExit(what)) return
      event.preventDefault()
      if (clearing) return
      clearing = true
      const wipe = clearOnExit(what, {
        clearCookies: async () => {
          for (const s of webSessionList()) await s.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
        },
        clearCache: async () => {
          for (const s of webSessionList()) await s.clearCache()
        },
        clearHistory: async () => {
          const history = storageCategories().find((c) => c.id === 'history')
          if (!history?.clear) throw new Error('History has no clear step registered.')
          await history.clear.run()
        },
      })
      void Promise.race([wipe, new Promise<string[]>((r) => setTimeout(() => r(['timeout']), 4000))]).then((failed) => {
        if (failed.length) log.warn('privacy', 'Clearing on exit did not finish', { failed: failed.join(', ') })
        cleared = true
        electronApp.quit()
      })
    }
    electronApp.on('will-quit', onWillQuit)
  }

  const webSessionList = (): Session[] => [...sessions].filter((s) => webSessions.has(s))

  // ---- per tab ----

  const wireTab = (tab: Tab, win: WindowContext): (() => void) => {
    const wc = tab.view.webContents
    const e: TabEntry = { tab, win, tracker: new PageErrorTracker(), downloads: 0, blockedDownload: null, blockedRedirect: null }
    entries.set(tab.id, e)
    byWebContents.set(wc.id, e)
    const update = (didChange: boolean): void => {
      if (didChange) changed(e)
    }

    const onFail = (_ev: Event, code: number, _desc: string, url: string, isMainFrame: boolean): void => {
      const blockedBy = isMainFrame ? blockedNavigations.take(wc.id, url) : null
      // A lost connection is checked at once, so the page says offline rather than "not found".
      if (isMainFrame && (code === -106 || code === -21)) void watch?.check()
      // Privacy pack: a failed HTTPS-First upgrade gets its own page, at the http address the person asked for.
      const insecure = isMainFrame ? httpsUpgrades.failed(wc.id, code) : null
      update(e.tracker.failed(code, insecure ?? url, isMainFrame, { online: network.isOnline() && net.isOnline(), blockedBy, httpsFallback: insecure !== null }))
    }
    const onNavigate = (_ev: Event, url: string): void => {
      pendingCertificates.clear(wc.id)
      blockedPopups.clear(tab.id)
      e.downloads = 0
      e.blockedRedirect = null
      closePageNotice(win, tab.id)
      const host = hostOfUrl(url)
      sites.setCertificateException(tab.id, host !== '' && /^https:/i.test(url) && certificateDecisions(wc.session).hasHost(host))
      e.tracker.navigated()
      changed(e)
    }
    const onStart = (): void => update(e.tracker.startedLoading())
    const onStop = (): void => update(e.tracker.stoppedLoading())
    const onGone = (_ev: Event, details: Electron.RenderProcessGoneDetails): void => {
      closePageNotice(win, tab.id, 'unresponsive')
      update(e.tracker.crashed(details.reason))
    }
    const onUnresponsive = (): void => {
      if (!e.tracker.unresponsive()) return
      changed(e)
      notice(e, 'unresponsive', '', 1)
    }
    const onResponsive = (): void => {
      closePageNotice(win, tab.id, 'unresponsive')
      update(e.tracker.responsive())
    }
    const onInput = (_ev: Event, input: Electron.InputEvent): void => {
      if (isGestureInput(input.type)) gestures.note(wc.id)
    }
    const onWillNavigate = (details: Event<WebContentsWillNavigateEventParams>): void => {
      if (!details.isMainFrame) return
      const initiator = details.initiator
      if (!initiator) return
      let frameUrl: string | null = null
      let frameIsTop = true
      try {
        frameUrl = initiator.url
        frameIsTop = initiator.parent === null
      } catch {
        return
      }
      const page = wc.getURL()
      const origin = originOf(page)
      const blocked = redirectBlocked({
        pageUrl: page,
        frameUrl,
        targetUrl: details.url,
        frameIsTop,
        userGesture: gestures.had(wc.id),
        siteRule: origin ? siteRules(wc.session, origin).popups : 'default',
        blockingOn: settings().popupBlocking,
      })
      if (!blocked) return
      details.preventDefault()
      e.blockedRedirect = details.url
      notice(e, 'redirect', details.url, 1)
    }

    wc.on('did-fail-load', onFail)
    wc.on('did-navigate', onNavigate)
    wc.on('did-start-loading', onStart)
    wc.on('did-stop-loading', onStop)
    wc.on('render-process-gone', onGone)
    wc.on('unresponsive', onUnresponsive)
    wc.on('responsive', onResponsive)
    wc.on('input-event', onInput)
    wc.on('will-navigate', onWillNavigate)
    const id = wc.id
    return () => {
      entries.delete(tab.id)
      byWebContents.delete(id)
      blockedPopups.clear(tab.id)
      blockedNavigations.forget(id)
      pendingCertificates.clear(id)
      gestures.forget(id)
      sites.setCertificateException(tab.id, false)
      closePageNotice(win, tab.id)
      if (wc.isDestroyed()) return
      wc.off('did-fail-load', onFail)
      wc.off('did-navigate', onNavigate)
      wc.off('did-start-loading', onStart)
      wc.off('did-stop-loading', onStop)
      wc.off('render-process-gone', onGone)
      wc.off('unresponsive', onUnresponsive)
      wc.off('responsive', onResponsive)
      wc.off('input-event', onInput)
      wc.off('will-navigate', onWillNavigate)
    }
  }

  // ---- services ----

  const pageErrors: SiteServices['pageErrors'] = {
    retry(tabId) {
      const e = entryOf(tabId)
      const wc = e.tab.view.webContents
      if (e.tracker.state().unresponsive) reloadHung(wc)
      else wc.reload()
    },
    leave(tabId) {
      const wc = entryOf(tabId).tab.view.webContents
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      else void wc.loadURL('about:blank').catch(() => undefined)
    },
    proceed(tabId) {
      const e = entryOf(tabId)
      const wc = e.tab.view.webContents
      const error = e.tracker.state().error
      if (!error) throw new Error('This page has nothing to proceed past.')
      const host = hostOfUrl(error.url)
      if (error.kind === 'certificate') {
        const cert = pendingCertificates.get(wc.id)
        if (!cert || cert.host !== host) throw new Error(`${BRAND_NAME} no longer has this site’s certificate. Try again first.`)
        certificateDecisions(wc.session).allow(host, cert.fingerprint)
      } else if (error.kind === 'https-unavailable') {
        // Continue to site (privacy pack): remembered for the site, then the http address itself.
        privacyExceptions.storeFor(wc.session)?.set('https', host, true)
        void wc.loadURL(error.url).catch(() => undefined)
        return
      } else if (error.kind === 'dangerous-site') {
        safety.allowHost(wc.session, host)
      } else {
        throw new Error('This page has nothing to proceed past.')
      }
      wc.reload()
    },
    allowAdblock(tabId) {
      const e = entryOf(tabId)
      const wc = e.tab.view.webContents
      const origin = originOf(e.tracker.state().error?.url ?? wc.getURL())
      if (!origin) throw new Error('This page has no site to allow.')
      setSite(wc.session, origin, { adblock: 'allow' })
      wc.reload()
    },
    details(tabId) {
      const e = entries.get(tabId)
      const error = e?.tracker.state().error
      if (!e || !error || e.tab.view.webContents.isDestroyed()) return null
      const wc = e.tab.view.webContents
      const cert = error.kind === 'certificate' ? pendingCertificates.get(wc.id) : null
      const details: PageErrorDetails = {
        kind: error.kind,
        url: error.url,
        host: hostOfUrl(error.url),
        code: error.code,
        codeName: cert ? cert.error.replace(/^net::/, '') : netErrorName(error.code),
        certificate: cert?.details ?? null,
        canGoBack: wc.navigationHistory.canGoBack(),
      }
      return details
    },
  }

  return {
    services: {
      pageErrors,
      network: { check: () => (watch ? watch.check() : Promise.resolve(network.isOnline())) },
    },
    session(s, info) {
      start()
      installSession(s, info)
    },
    window(win) {
      // Both live as long as the window's TabManager does.
      win.tabs.decorate(decorate)
      win.tabs.cover((tab) => {
        if (tab.internalUrl) return false
        return entries.get(tab.id)?.tracker.covering ?? false
      })
    },
    tab: wireTab,
    dispose() {
      for (const stop of stops.splice(0)) stop()
    },
  }
}

/**
 * Adds site safety to the sites feature: its services join the sites
 * feature's, and each hook runs after the sites feature's (so the session's
 * site store is attached first). A failure in one part never stops the other.
 */
export function withSafety(inner: Feature): Feature {
  let rt: SafetyRuntime | null = null
  const guard = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn()
    } catch (err) {
      log.warn('sites', `Safety ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
  return {
    ...inner,
    app(app) {
      const parts: ServiceParts = inner.app?.(app) ?? {}
      const own = createSafety(app)
      rt = own
      return { ...parts, network: { ...parts.network, ...own.services.network }, pageErrors: own.services.pageErrors }
    },
    session(session, info) {
      guard('session', () => inner.session?.(session, info))
      guard('session', () => rt?.session(session, info))
    },
    window(win) {
      const parts = guard('window', () => inner.window?.(win))
      guard('window', () => rt?.window(win))
      return parts ?? undefined
    },
    tab(tab, win) {
      const a = guard('tab', () => inner.tab?.(tab, win))
      const b = guard('tab', () => rt?.tab(tab, win))
      return () => {
        a?.()
        b?.()
      }
    },
  }
}

function pick(s: Settings): PrivacyCache {
  return {
    blockThirdPartyCookies: s.blockThirdPartyCookies,
    globalPrivacyControl: s.globalPrivacyControl,
    clearOnExit: { ...s.clearOnExit },
    proxy: { ...s.proxy },
    popupBlocking: s.popupBlocking,
    adblock: s.adblock,
  }
}
