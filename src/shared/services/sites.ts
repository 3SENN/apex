/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The sites services and events: per-site settings, site info and the online state.
import type { PageErrorDetails } from '../safety'
import type { CaptureKind, CaptureState, DeviceEntry, PermissionDecision, ScreenSources, SiteDataEntry, SiteInfo, SitePermission, SiteSettings, SiteSettingsEntry, SiteSettingsPatch } from '../sites'
import type { GrantedDevice } from '../sites' // permissions pass: site info

export interface SiteServices {
  sites: {
    get(origin: string): SiteSettings
    set(origin: string, patch: SiteSettingsPatch): SiteSettings
    permission(origin: string, perm: SitePermission): PermissionDecision
    list(): SiteSettingsEntry[]
    /** Async: the cookie count and storage sizes are measured on the way. */
    info(tabId: string): Promise<SiteInfo>
    clearSiteData(origin: string): Promise<void>
    clearCache(origin?: string): Promise<void>
    /** Used by the tab menu (Mute site). */
    setMuted(origin: string, muted: boolean): void
    /** Removes every override a site has (site settings' Reset). */
    forget(origin: string): void
    /** The cookies and site data list, by registrable domain. */
    dataList(): Promise<SiteDataEntry[]>
    /** Clears cookies and stored data for a registrable domain and its subdomains. */
    clearDomainData(domain: string): Promise<void>
    /** The screen picker's sources for an open request, with fresh thumbnails (OV-14). */
    screenSources(requestId: string): Promise<ScreenSources>
    /** The sharing bar's Stop: ends the tab's capture of these kinds (all when omitted). */
    stopCapture(tabId: string, kinds?: CaptureKind[]): void
    /** Opens the macOS privacy pane for the camera, microphone or Screen Recording. */
    openSystemSettings(pane: 'camera' | 'microphone' | 'screen' | 'location'): void
    // ── permissions pass: site info services ──
    /** Site info's Revoke on an "Allowed this time" permission: the tab's site asks again (and a capture of it ends). */
    revokeOneTime(tabId: string, perm: SitePermission): void
    /** Site info's Revoke on a device: the remembered grant and the one for this session both go. */
    revokeDevice(tabId: string, device: Pick<GrantedDevice, 'kind' | 'id'>): void
    // ── permissions pass services ──
    /** The address bar's quiet chip: answers a notification request that was held back instead of prompting. */
    answerQuiet(tabId: string, permission: SitePermission, allow: boolean): void
  }
  network: {
    isOnline(): boolean
    /** Checks the connection now (the Connectors page's Retry now); resolves to the new state. */
    check(): Promise<boolean>
  }
  // SS-07: what the error pages do
  pageErrors: {
    /** Retry and Reload: loads the failed page again, or brings a crashed or stuck one back. */
    retry(tabId: string): void
    /** Back to safety: the previous page, else the new tab. */
    leave(tabId: string): void
    /** Proceed anyway (certificate) or Visit anyway (dangerous site) for this session, then reload. */
    proceed(tabId: string): void
    /** Allow on this site, from the blocked-by-ad-blocker page: the site's ad blocking off, then reload. */
    allowAdblock(tabId: string): void
    /** The interstitial's small print: the code's name and, on a certificate error, the certificate offered. */
    details(tabId: string): PageErrorDetails | null
  }
}

export type SiteEvent =
  | { type: 'online'; online: boolean }
  /** A site's settings changed (site info, site settings and the notification settings list refresh). */
  | { type: 'site-settings'; origin: string }
  /**
   * An open site request changed in main: it ended (its tab closed, navigated or
   * the agent took over), or the device chooser's list moved. The surface for
   * that request follows it.
   */
  | { type: 'site-request'; requestId: string; closed?: boolean; devices?: DeviceEntry[]; scanning?: boolean }
  /** A tab's capture changed (the sharing bar follows it; TabInfo.capture carries it for the tab strip). */
  | { type: 'capture'; tabId: string; capture: CaptureState; sharedTab: string | null }
