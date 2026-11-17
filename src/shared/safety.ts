/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page errors, site safety and page notices (SS-07).
// Pure rules shared by main and the chrome: which
// failed-load codes become which Atelier error page, the dangerous-host list, the
// download risk classifier and the props of the page notice surface.
import type { CertificateDetails, DownloadClassifyInput, DownloadDanger, PageErrorKind } from './sites'

// ---- failed loads ----

/** Chromium's net error names for the codes Atelier shows (net/base/net_error_list.h). */
const NET_ERRORS: Readonly<Record<number, string>> = {
  [-2]: 'ERR_FAILED',
  [-3]: 'ERR_ABORTED',
  [-6]: 'ERR_FILE_NOT_FOUND',
  [-7]: 'ERR_TIMED_OUT',
  [-10]: 'ERR_ACCESS_DENIED',
  [-15]: 'ERR_SOCKET_NOT_CONNECTED',
  [-20]: 'ERR_BLOCKED_BY_CLIENT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-27]: 'ERR_BLOCKED_BY_RESPONSE',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-103]: 'ERR_CONNECTION_ABORTED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-113]: 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED',
  [-138]: 'ERR_NETWORK_ACCESS_DENIED',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-203]: 'ERR_CERT_CONTAINS_ERRORS',
  [-204]: 'ERR_CERT_NO_REVOCATION_MECHANISM',
  [-205]: 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION',
  [-206]: 'ERR_CERT_REVOKED',
  [-207]: 'ERR_CERT_INVALID',
  [-208]: 'ERR_CERT_WEAK_SIGNATURE_ALGORITHM',
  [-210]: 'ERR_CERT_NON_UNIQUE_NAME',
  [-211]: 'ERR_CERT_WEAK_KEY',
  [-212]: 'ERR_CERT_NAME_CONSTRAINT_VIOLATION',
  [-213]: 'ERR_CERT_VALIDITY_TOO_LONG',
  [-214]: 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED',
  [-300]: 'ERR_INVALID_URL',
  [-301]: 'ERR_DISALLOWED_URL_SCHEME',
  [-302]: 'ERR_UNKNOWN_URL_SCHEME',
  [-310]: 'ERR_TOO_MANY_REDIRECTS',
  [-324]: 'ERR_EMPTY_RESPONSE',
  [-501]: 'ERR_INSECURE_RESPONSE',
}

/** The code's Chromium name, for the error page's small print. */
export function netErrorName(code: number): string {
  return NET_ERRORS[code] ?? `ERR_${Math.abs(code)}`
}

/** Certificate errors are -200 to -299 (plus the older ERR_INSECURE_RESPONSE). */
export function isCertificateError(code: number): boolean {
  return (code <= -200 && code > -300) || code === -501
}

/** Why Atelier's own request mux cancelled a navigation, so its ERR_BLOCKED_BY_CLIENT gets the right page. */
export type BlockReason = 'adblock' | 'dangerous' | 'lockdown' | 'content'

const OFFLINE = new Set([-21, -106])
const NOT_FOUND = new Set([-105, -137])
const REFUSED = new Set([-15, -100, -101, -102, -103, -104, -109])
const TIMED_OUT = new Set([-7, -118])

/**
 * Maps a main-frame did-fail-load code to Atelier's error page. null means show
 * nothing: ERR_ABORTED is a stop, a download or a replaced navigation. A name
 * or connection failure while the system is offline is the offline page,
 * since that is what the person can act on.
 */
export function classifyLoadFailure(code: number, ctx: { online: boolean; blockedBy?: BlockReason | null; httpsFallback?: boolean }): PageErrorKind | null {
  if (code === -3 || code === 0) return null
  // The privacy pack's HTTPS-First already decided this failure was the site's missing https.
  if (ctx.httpsFallback) return 'https-unavailable'
  if (code === -20 || code === -27) {
    if (ctx.blockedBy === 'dangerous') return 'dangerous-site'
    if (ctx.blockedBy === 'adblock') return 'blocked-by-adblock'
    return 'other'
  }
  if (isCertificateError(code)) return 'certificate'
  if (OFFLINE.has(code)) return 'offline'
  if (!ctx.online && (NOT_FOUND.has(code) || REFUSED.has(code) || TIMED_OUT.has(code))) return 'offline'
  if (NOT_FOUND.has(code)) return 'not-found'
  if (REFUSED.has(code)) return 'refused'
  if (TIMED_OUT.has(code)) return 'timed-out'
  if (code === -310) return 'too-many-redirects'
  return 'other'
}

/** Kinds whose page reloads by itself when the connection returns (SS-06). */
export const AUTO_RETRY_KINDS: ReadonlySet<PageErrorKind> = new Set<PageErrorKind>(['offline'])

/** Kinds that offer a way past them (Proceed anyway, Visit anyway, Allow on this site). */
export function isBypassable(kind: PageErrorKind): boolean {
  return kind === 'certificate' || kind === 'dangerous-site' || kind === 'blocked-by-adblock'
}

/** What the interstitial's advanced section shows (pageErrors.details). */
export interface PageErrorDetails {
  kind: PageErrorKind
  url: string
  host: string
  code: number
  codeName: string
  /** The certificate the site offered, on a certificate error. */
  certificate: CertificateDetails | null
  canGoBack: boolean
}

// ---- the dangerous-host list ----

/**
 * Parses the bundled list: one host per line, '#' starts a comment, blank
 * lines are skipped. Hosts are lower-cased; a leading '*.' or '.' is dropped,
 * since every entry covers its subdomains anyway.
 */
export function parseHostList(text: string): Set<string> {
  const hosts = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '')
    if (line && /^[a-z0-9.-]+$/.test(line) && line.includes('.')) hosts.add(line)
  }
  return hosts
}

/** Whether a host or any of its parent domains is listed. */
export function hostListed(list: ReadonlySet<string>, host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, '')
  while (h) {
    if (list.has(h)) return true
    const dot = h.indexOf('.')
    if (dot < 0) return false
    h = h.slice(dot + 1)
  }
  return false
}

export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

// ---- the download classifier (used by the downloads surfaces) ----

/** Programs, installers and scripts that run when opened. */
const RUNNABLE = new Set([
  'app', 'apk', 'appimage', 'bat', 'bin', 'cmd', 'com', 'command', 'cpl', 'deb', 'dll', 'dmg', 'exe', 'gadget', 'hta', 'inf',
  'ins', 'isp', 'jar', 'js', 'jse', 'lnk', 'mpkg', 'msc', 'msi', 'msix', 'msp', 'pif', 'pkg', 'ps1', 'psm1', 'reg', 'rpm',
  'run', 'scf', 'scpt', 'scr', 'sh', 'shb', 'terminal', 'tool', 'url', 'vb', 'vbe', 'vbs', 'workflow', 'ws', 'wsc', 'wsf', 'wsh',
])

/** Documents that can carry macros or launch things; worth a second look, never blocked. */
const RISKY_DOCUMENTS = new Set(['docm', 'xlsm', 'pptm', 'xlam', 'iso', 'img', 'vhd', 'vhdx', 'svg', 'html', 'htm', 'xht', 'xhtml', 'mht', 'mhtml', 'swf'])

const RUNNABLE_MIME = /^application\/(x-msdownload|x-msdos-program|x-ms-installer|vnd\.microsoft\.portable-executable|x-apple-diskimage|x-sh|x-shellscript|x-executable|x-mach-binary|java-archive|x-java-archive|vnd\.android\.package-archive|x-msi|x-bat)$/i

/** Hidden direction marks and padding that disguise an extension ("invoice‮fdp.exe", "photo.jpg      .exe"). */
const DISGUISE = /[‪-‮⁦-⁩‎‏]|\s{3,}\.\w+$/

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** "invoice.pdf.exe": a harmless-looking extension in front of a runnable one. */
function doubleExtension(filename: string): boolean {
  const parts = (filename.split(/[\\/]/).pop() ?? '').toLowerCase().split('.')
  if (parts.length < 3) return false
  const last = parts[parts.length - 1] ?? ''
  const before = parts[parts.length - 2] ?? ''
  return RUNNABLE.has(last) && /^(pdf|docx?|xlsx?|pptx?|txt|jpe?g|png|gif|mp3|mp4|mov|zip)$/.test(before)
}

/**
 * How risky a download looks, from what Atelier knows locally (there is no
 * Safe Browsing backend): files from a listed host, disguised names and
 * programs fetched over plain http are dangerous; other programs, installers
 * and macro documents are uncommon, so they wait for Keep or Discard.
 */
export function classifyDownload(d: DownloadClassifyInput, isDangerousHost: (host: string) => boolean): DownloadDanger {
  const host = hostOfUrl(d.url)
  const referrerHost = hostOfUrl(d.referrer)
  if ((host && isDangerousHost(host)) || (referrerHost && isDangerousHost(referrerHost))) return 'dangerous'
  const ext = extensionOf(d.filename)
  const runnable = RUNNABLE.has(ext) || RUNNABLE_MIME.test(d.mime)
  if (DISGUISE.test(d.filename) || doubleExtension(d.filename)) return 'dangerous'
  if (runnable && /^http:/i.test(d.url) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(d.url)) return 'dangerous'
  if (runnable || RISKY_DOCUMENTS.has(ext)) return 'uncommon'
  return 'none'
}

// ---- page notices (the popup-blocked surface, SS-07) ----

/**
 * One tab-anchored notice surface serves every "Atelier stopped something on
 * this page" message: blocked pop-ups, a blocked redirect from a frame,
 * blocked automatic downloads and an unresponsive page.
 */
export type PageNoticeKind = 'popup' | 'redirect' | 'downloads' | 'unresponsive'

export interface PageNoticeProps {
  tabId: string
  kind: PageNoticeKind
  /** The site the tab shows. */
  host: string
  /** The blocked address (pop-up or redirect target); empty for the others. */
  target: string
  /** How many were blocked on this page so far. */
  count: number
}

/** What the notice resolves with; main acts on it. */
export type PageNoticeAnswer = 'once' | 'always' | 'wait' | 'reload'

export const PAGE_NOTICE_ANSWERS: readonly PageNoticeAnswer[] = ['once', 'always', 'wait', 'reload']
