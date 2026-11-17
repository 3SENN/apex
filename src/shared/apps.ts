/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Agent-built sandboxed apps. Each app is a single HTML document run at
// atelier-app://<appId>/ in its own locked-down partition (persist:atelier-app-<id>):
// no network, no popups, a strict CSP, and the agent never acts there.
import type { Owner } from './services'

export const ATELIER_APP_SCHEME = 'atelier-app'
/** Each app runs in its own persistent, locked-down partition: persist:atelier-app-<id>. */
export const ATELIER_APP_PARTITION_PREFIX = 'persist:atelier-app-'

export interface AppSummary {
  id: string
  name: string
  description: string
  owner: Owner
  currentVersionId: string | null
  draftVersionId: string | null
  updatedAt: number
  /** The companion id that built it. */
  createdBy: string
}

export interface AppVersion {
  id: string
  at: number
  size: number
  label: 'draft' | 'saved' | 'restored'
}

export interface AppsService {
  list(owner?: Owner): AppSummary[]
  get(id: string): AppSummary & { versions: AppVersion[] }
  save(input: { id?: string; name: string; description: string; owner?: Owner }): AppSummary
  saveDraft(id: string, versionId: string): AppSummary
  remove(id: string): void
  restoreVersion(id: string, versionId: string): AppSummary
  open(id: string, versionId?: string): void
  /** The New app flow: starts a chat that builds it; returns the chat id. */
  startBuild(description: string, companionId?: string): string
  exportHtml(id: string): Promise<string | null>
  /** A still of one version, rendered off-screen in the app's own sandbox; a PNG data URL, or null if it can't render. */
  preview(id: string, versionId: string): Promise<string | null>
}


/** One self-contained HTML file per version. */
export const APP_HTML_MAX = 2 * 1024 * 1024
/** Versions kept per app; the oldest that is neither current nor the draft goes first. */
export const APP_VERSIONS_MAX = 30

/** Sent with every atelier-app response: inline code and data URLs only, nothing reaches the network. */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

const APP_ID = /^[0-9a-f-]{36}$/
const VERSION_ID = /^[A-Za-z0-9-]{1,64}$/

const RULES: Array<{ re: RegExp; reason: string }> = [
  { re: /<script\b[^>]*\bsrc\s*=/i, reason: 'Scripts must be inline: the app loads a script from a file or address.' },
  { re: /<link\b/i, reason: 'Styles, fonts and icons must be inline: the app has a <link> element.' },
  { re: /<(iframe|frame|frameset|object|embed|portal|applet)\b/i, reason: 'Apps can’t embed other pages or plug-ins.' },
  { re: /<base\b/i, reason: 'Apps can’t set a <base> address.' },
  { re: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, reason: 'Apps can’t redirect themselves.' },
  { re: /@import\b/i, reason: 'Styles must be inline: the app imports a stylesheet.' },
  { re: /url\(\s*["']?\s*(?!data:|blob:|#)[^)\s"']/i, reason: 'Images and fonts in styles must be data: URLs.' },
  {
    re: /<[a-z][^>]*?\s(src|srcset|poster|data|background|formaction|action|xlink:href)\s*=\s*["']?\s*(?!data:|blob:|#)[^\s>"']/i,
    reason: 'Images, media and forms must use data: URLs or stay on the page.',
  },
  { re: /<(image|use|feimage)\b[^>]*\shref\s*=\s*["']?\s*(?!data:|#)[^\s>"']/i, reason: 'SVG images must be data: URLs.' },
]

/** Checks an app's HTML before it is stored: one self-contained file, nothing it would fetch. */
export function validateAppHtml(html: string): { ok: true } | { ok: false; reason: string } {
  if (!html.trim()) return { ok: false, reason: 'The app is empty.' }
  if (new TextEncoder().encode(html).length > APP_HTML_MAX) return { ok: false, reason: 'The app is larger than 2 MB.' }
  for (const rule of RULES) if (rule.re.test(html)) return { ok: false, reason: rule.reason }
  return { ok: true }
}

/** atelier-app://<id>/, or atelier-app://<id>/?version=<v> for one version. Any other path is not part of an app. */
export function parseAppUrl(url: string): { appId: string; versionId: string | null } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ATELIER_APP_SCHEME}:`) return null
  const appId = parsed.hostname
  if (!APP_ID.test(appId) || (parsed.pathname !== '/' && parsed.pathname !== '')) return null
  if (parsed.username || parsed.password || parsed.port) return null
  const version = parsed.searchParams.get('version')
  if (version !== null && !VERSION_ID.test(version)) return null
  return { appId, versionId: version }
}

/** Where one version of an app runs (the preview of a draft). */
export function appVersionUrl(appId: string, versionId: string): string {
  return `${ATELIER_APP_SCHEME}://${appId}/?version=${encodeURIComponent(versionId)}`
}

/** The app id an address belongs to, or null. */
export function appIdOf(url: string): string | null {
  return parseAppUrl(url)?.appId ?? null
}
