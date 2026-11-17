/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { displayHost } from '@shared/domains'
import { siteKey } from '@shared/permissions'
import { DEFAULT_SITE_SETTINGS, type GrantedDevice, type SecurityState, type SiteInfo, type SitePermission } from '@shared/sites'
import type { Session } from 'electron'
import type { CaptureTracker } from './capture'
import { certificates } from './certificates'
import { cookieCount, storageUsage } from './siteData'
import { sites } from './sites'
import type { Tab, TabManager } from './tabs'

// What the site-info popover shows for a tab (SH-37): the
// connection and certificate (from certificates.details), the site's
// settings, what it stores, what it is capturing, and what it may use this
// time only (one-time permissions and devices allowed without "remember").

export interface SiteInfoDeps {
  capture: CaptureTracker
  globals(): SiteInfo['globals']
  isPrivate(tab: Tab): boolean
  /** Permissions the tab allowed this time only. */
  oneTime?(tab: Tab): SitePermission[]
  /** Devices the site may use until its tabs close. */
  sessionDevices?(session: Session, origin: string): GrantedDevice[]
}

/** Security for a page: the site safety TabInfo decorator wins; otherwise the scheme says it. */
export function securityOf(manager: TabManager | null, tab: Tab, url: string): SecurityState {
  const decorated = manager?.info(tab).security
  if (decorated) return decorated
  if (tab.internalUrl) return 'internal'
  if (/^https:/i.test(url)) return 'secure'
  if (/^http:/i.test(url)) return 'insecure'
  return 'none'
}

export async function buildSiteInfo(tab: Tab, manager: TabManager | null, deps: SiteInfoDeps): Promise<SiteInfo> {
  const wc = tab.view.webContents
  const url = wc.isDestroyed() ? tab.requestedUrl : wc.getURL() || tab.requestedUrl
  const origin = siteKey(url) ?? ''
  const shown = displayHost(url)
  const session = wc.isDestroyed() ? null : wc.session
  const store = sites.storeFor(session)
  const [cookies, usage] = origin && session ? await Promise.all([cookieCount(session, origin).catch(() => 0), storageUsage(wc, origin)]) : [0, { cacheBytes: 0, dataBytes: 0 }]
  return {
    tabId: tab.id,
    url,
    origin,
    host: shown.host,
    registrable: shown.registrable,
    punycodeWarning: shown.punycodeWarning,
    security: securityOf(manager, tab, url),
    certificate: shown.host && /^https:/i.test(url) ? certificates.details(shown.host) : null,
    settings: origin && store ? store.get(origin) : structuredClone(DEFAULT_SITE_SETTINGS),
    cookieCount: cookies,
    cacheBytes: usage.cacheBytes,
    dataBytes: usage.dataBytes,
    globals: deps.globals(),
    privateSession: deps.isPrivate(tab),
    capture: deps.capture.state(tab.id),
    oneTime: origin ? (deps.oneTime?.(tab) ?? []) : [],
    sessionDevices: origin && session ? (deps.sessionDevices?.(session, origin) ?? []) : [],
  }
}
