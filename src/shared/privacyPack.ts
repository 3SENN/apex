/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The privacy pack's contract (Settings › Privacy, the site info popover):
// HTTPS-First, hidden cookie banners with optional downloaded lists, and the
// per-site privacy summary. Main implements it in src/main/privacy/.

export type PrivacyExceptionKind = 'https' | 'cookieBanners'

/** Hosts, sorted: sites allowed without HTTPS, and sites whose cookie banners Apex leaves alone. */
export interface PrivacyExceptions {
  https: string[]
  cookieBanners: string[]
}

export type CookieListId = 'easylist-cookie' | 'ublock-cookies'

export interface CookieListInfo {
  id: CookieListId
  /** The list's own name (a proper noun, not translated). */
  name: string
  /** Where Apex downloads it from; only when the person turns it on. */
  url: string
  /** The host the settings row names. */
  source: string
  /** Its licence, as the maintainers state it. */
  licence: string
}

/**
 * Community lists the person can add. Apex never bundles them: each is
 * downloaded from its maintainers when turned on and refreshed weekly, and
 * only its element-hiding rules are used.
 */
export const COOKIE_LISTS: readonly CookieListInfo[] = [
  { id: 'easylist-cookie', name: 'EasyList Cookie List', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', source: 'secure.fanboy.co.nz', licence: 'GPL-3.0 / CC BY-SA 3.0' },
  { id: 'ublock-cookies', name: 'uBlock filters – Cookie Notices', url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt', source: 'ublockorigin.github.io', licence: 'GPL-3.0' },
]

export const COOKIE_LIST_IDS = COOKIE_LISTS.map((l) => l.id) as [CookieListId, ...CookieListId[]]

export interface CookieListStatus {
  id: CookieListId
  enabled: boolean
  /** When the copy on disk was downloaded (ms), or null before the first download. */
  updatedAt: number | null
  /** Hiding rules Apex took from it. */
  rules: number
  state: 'idle' | 'updating' | 'failed'
}

/** How the page in the tab was reached. */
export type ConnectionSummary =
  /** Over https, as asked. */
  | 'https'
  /** Asked for http; HTTPS-First opened the https version. */
  | 'upgraded'
  /** Over http, on a site the person let load without HTTPS. */
  | 'http-allowed'
  /** Over http: HTTPS-First is off, or the address is local. */
  | 'http'
  /** Not a website (apex:// pages, files, the new tab). */
  | 'none'

export type CookieBannerState =
  /** Apex pressed the banner's Reject button. */
  | 'rejected'
  /** A banner was there and is hidden. */
  | 'hidden'
  /** Still watching the page (consent tools load late). */
  | 'checking'
  /** No banner Apex knows. */
  | 'none'
  /** The person lets this site show its banner. */
  | 'allowed'
  /** Hide cookie banners is off. */
  | 'off'

export interface PrivacySummary {
  host: string
  connection: ConnectionSummary
  /** Ads and trackers the blocker stopped on this page. */
  trackersBlocked: number
  /** Whether the ad and tracker blocker runs on this page. */
  blocking: boolean
  cookieBanner: CookieBannerState
}

export interface PrivacyPackServices {
  privacy: {
    /** The tab's page: connection, trackers blocked and its cookie banner; null when the tab is gone or not a website. */
    summary(tabId: string): Promise<PrivacySummary | null>
    /** This window's profile's exceptions. */
    exceptions(): Promise<PrivacyExceptions>
    /** Adds or removes one; open pages of that site follow at once (cookie banners) or on their next load (https). */
    setException(kind: PrivacyExceptionKind, host: string, on: boolean): Promise<PrivacyExceptions>
    cookieLists(): Promise<CookieListStatus[]>
    /** Downloads every enabled list again now. */
    updateCookieLists(): Promise<CookieListStatus[]>
  }
}
