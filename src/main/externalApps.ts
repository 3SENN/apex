/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app } from 'electron'
import { externalScheme, isSilentExternal } from '@shared/permissions'
import type { SiteStore } from './sites'

// Links that open another app. Electron asks the session's
// permission handler with 'openExternal' before it hands a link to the
// system; Apex names the app that would open, asks, and remembers only an
// allow, per site and scheme. Mail links open without asking.

export interface ExternalLink {
  url: string
  scheme: string
  /** The app the system would open, or null when none is registered. */
  app: string | null
}

/** What would open the link; null when it isn't an external link at all. */
export function describeExternal(url: string): ExternalLink | null {
  const scheme = externalScheme(url)
  if (!scheme || scheme === 'http' || scheme === 'https' || scheme === 'javascript' || scheme === 'file' || scheme === 'data') return null
  let name: string | null = null
  try {
    name = app.getApplicationNameForProtocol(url).replace(/\.app$/i, '').trim() || null
  } catch {
    name = null
  }
  return { url, scheme, app: name }
}

/** The stored answer for a site and scheme: an allow when it was remembered, otherwise ask. */
export function externalDecision(store: SiteStore | null, origin: string, link: ExternalLink): 'allow' | 'ask' {
  if (isSilentExternal(link.url)) return 'allow'
  return store?.get(origin).externalSchemes.includes(link.scheme) ? 'allow' : 'ask'
}

/** Remembers an allow for a site and scheme (the only answer external apps keep). */
export function rememberExternal(store: SiteStore, origin: string, scheme: string): void {
  const current = store.get(origin).externalSchemes
  if (!current.includes(scheme)) store.set(origin, { externalSchemes: [...current, scheme] })
}
