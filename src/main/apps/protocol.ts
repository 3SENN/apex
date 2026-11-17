/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The atelier-app:// sandbox. Each app runs in its own
// persistent partition, persist:atelier-app-<id>, which only ever serves that
// app's HTML with a strict CSP. Defence in depth, because agent-built HTML
// is untrusted:
//   - the CSP allows inline code and data URLs only, no network;
//   - the session refuses http, https, ws and file itself, and is locked down
//     through webRequest.lockdown (enforced once the mux is installed);
//   - every permission and download is denied;
//   - the view is sandboxed with no preload; navigation and window.open are
//     blocked; the agent never acts there (browserTool treats it as an Atelier page).
// Every page is served with Atelier UI first in its <head> (ui.ts, APP-UI).
import { session as electronSession, type Session, type WebContents, type WebPreferences } from 'electron'
import { ATELIER_APP_PARTITION_PREFIX, ATELIER_APP_SCHEME, APP_CSP, parseAppUrl } from '@shared/apps'
import { log } from '../log'
import { permissionPolicy } from '../permissionPolicy'
import type { SessionInfo } from '../features/types'
import { webRequest } from '../webRequest'
import type { AppStore } from './store'
import { withAppUi } from './ui'

/** The headers every app response carries. */
export function appResponseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': APP_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), display-capture=()',
  }
}

/** What an atelier-app request inside app `appId`'s partition gets back, with `style` (Atelier UI) in its head. Anything outside that one app is a 404. */
export function serveApp(store: Pick<AppStore, 'html'>, appId: string, url: string, style: (appId: string) => string = () => ''): Response {
  const target = parseAppUrl(url)
  if (!target || target.appId !== appId) return new Response('Not found', { status: 404 })
  try {
    return new Response(withAppUi(store.html(appId, target.versionId), style(appId)), { headers: appResponseHeaders() })
  } catch {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
}

/** Only this app's own address may load in its partition. */
export function appRequestAllowed(appId: string, url: string): boolean {
  return parseAppUrl(url)?.appId === appId || url.startsWith('data:') || url.startsWith('blob:')
}

export interface AppSandbox {
  session(appId: string): Session
  /** WebPreferences for a tab or off-screen view showing an app; null for any other address. */
  preferencesFor(url: string): WebPreferences | null
  /** Blocks navigation, pop-ups and downloads for one app view. */
  harden(contents: WebContents, appId: string): void
  isAppSession(session: Session): boolean
}

export function createAppSandbox(store: AppStore, installSession: () => ((session: Session, info: SessionInfo) => void) | null, style?: (appId: string) => string): AppSandbox {
  const sessions = new Map<string, Session>()

  const sessionFor = (appId: string): Session => {
    const existing = sessions.get(appId)
    if (existing) return existing
    if (!parseAppUrl(`${ATELIER_APP_SCHEME}://${appId}/`)) throw new Error('This app no longer exists.')
    const partition = `${ATELIER_APP_PARTITION_PREFIX}${appId}`
    const ses = electronSession.fromPartition(partition)
    ses.protocol.handle(ATELIER_APP_SCHEME, (request) => serveApp(store, appId, request.url, style))
    // The network is not part of an app. Each scheme refuses before anything leaves the machine.
    for (const scheme of ['http', 'https', 'ws', 'wss', 'file']) {
      try {
        ses.protocol.handle(scheme, () => new Response('Apps have no network access.', { status: 403 }))
      } catch {
        // Some builds can't intercept every built-in scheme; the CSP and the lockdown still hold.
      }
    }
    webRequest.lockdown(ses, (d) => appRequestAllowed(appId, d.url))
    permissionPolicy.addOverride((r) => (r.session === ses ? 'deny' : null))
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', (event, item) => {
      event.preventDefault()
      item.cancel()
    })
    installSession()?.(ses, { private: true, partition })
    sessions.set(appId, ses)
    log.debug('apps', 'sandbox session ready')
    return ses
  }

  return {
    session: sessionFor,
    preferencesFor(url) {
      const target = parseAppUrl(url)
      if (!target || !store.has(target.appId)) return null
      return {
        session: sessionFor(target.appId),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'user-gesture-required',
      }
    },
    harden(contents, appId) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const keep = (event: { preventDefault(): void; url: string }): void => {
        if (parseAppUrl(event.url)?.appId !== appId) event.preventDefault()
      }
      contents.on('will-navigate', keep)
      contents.on('will-redirect', keep)
      contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame) event.preventDefault()
      })
      contents.on('will-attach-webview', (event) => event.preventDefault())
    },
    isAppSession: (ses) => [...sessions.values()].includes(ses),
  }
}
