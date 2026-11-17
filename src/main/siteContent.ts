/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeRequestListenerDetails, OnHeadersReceivedListenerDetails } from 'electron'
import type { SiteSettings } from '@shared/sites'
import { originOf } from './privacy'
import type { WebRequestHooks } from './webRequest'

// Per-site content switches, the mux's third layer:
// JavaScript, images and insecure content, judged by the page the request
// belongs to. Blocking JavaScript cancels script requests and adds a
// script-src 'none' policy to the site's documents, which stops inline
// scripts too. Insecure content set to block refuses every http subresource
// on an https page; Chromium's own mixed-content rules stay in force otherwise.

export interface ContentContext {
  /** The site settings for an origin in this session. */
  rules(origin: string): Pick<SiteSettings, 'javascript' | 'images' | 'insecureContent'>
  /** The top-level page's URL for a request (null without a page). */
  topUrl(details: { webContents?: Electron.WebContents; resourceType: string; url: string }): string | null
}

/** The page's URL: the request itself for a top-level document. */
function pageUrl(ctx: ContentContext, d: { webContents?: Electron.WebContents; resourceType: string; url: string }): string | null {
  return d.resourceType === 'mainFrame' ? d.url : ctx.topUrl(d)
}

export type ContentVerdict = 'allow' | 'block-script' | 'block-image' | 'block-insecure'

/** Pure: what the switches say about one subresource of a page. */
export function contentVerdict(resourceType: string, requestUrl: string, page: string | null, rules: ContentContext['rules']): ContentVerdict {
  if (!page || resourceType === 'mainFrame') return 'allow'
  const origin = originOf(page)
  if (!origin) return 'allow'
  const r = rules(origin)
  if (resourceType === 'script' && r.javascript === 'block') return 'block-script'
  if (resourceType === 'image' && r.images === 'block') return 'block-image'
  if (r.insecureContent === 'block' && /^https:/i.test(page) && /^http:/i.test(requestUrl)) return 'block-insecure'
  return 'allow'
}

const NO_SCRIPT = "script-src 'none'"

export function contentLayer(ctx: ContentContext): WebRequestHooks {
  return {
    onBeforeRequest(d: OnBeforeRequestListenerDetails) {
      return contentVerdict(d.resourceType, d.url, pageUrl(ctx, d), ctx.rules) === 'allow' ? null : { cancel: true }
    },
    onHeadersReceived(d: OnHeadersReceivedListenerDetails) {
      if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return null
      const page = pageUrl(ctx, d)
      const origin = page ? originOf(page) : null
      if (!origin || ctx.rules(origin).javascript !== 'block') return null
      // A second policy header is enforced alongside the site's own, so this only ever tightens.
      const headers = { ...(d.responseHeaders ?? {}) }
      const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy'
      headers[key] = [...(headers[key] ?? []), NO_SCRIPT]
      return { responseHeaders: headers }
    },
  }
}
