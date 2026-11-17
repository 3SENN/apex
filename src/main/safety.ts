/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeRequestListenerDetails } from 'electron'
import { classifyDownload, hostListed, hostOfUrl, parseHostList } from '@shared/safety'
import type { DownloadClassifyInput, DownloadDanger } from '@shared/sites'
import listText from './data/dangerous-hosts.txt?raw'
import { blockedNavigations } from './navErrors'
import type { WebRequestHooks } from './webRequest'

// Download and site safety. The dangerous-host list ships
// with each release (data/dangerous-hosts.txt). A page on a listed host is
// refused before any request leaves, and the tab shows the dangerous-site
// interstitial; "Visit anyway" lets that host through for the rest of the
// session. classifyDownload serves the downloads' Keep or Discard.

const DANGEROUS = parseHostList(listText)
const exceptions = new WeakMap<object, Set<string>>()

function sessionExceptions(session: object): Set<string> {
  let set = exceptions.get(session)
  if (!set) {
    set = new Set()
    exceptions.set(session, set)
  }
  return set
}

export const safety = {
  classifyDownload(d: DownloadClassifyInput): DownloadDanger {
    return classifyDownload(d, (host) => safety.isDangerousHost(host))
  },
  isDangerousHost(host: string): boolean {
    return hostListed(DANGEROUS, host)
  },
  /** A listed page the person hasn't chosen to visit in this session. */
  blocks(session: object, url: string): boolean {
    const host = hostOfUrl(url)
    return host !== '' && safety.isDangerousHost(host) && !sessionExceptions(session).has(host)
  },
  /** "Visit anyway": the host stays reachable until the session ends. */
  allowHost(session: object, host: string): void {
    sessionExceptions(session).add(host.toLowerCase())
  },
  /** Whether the person went past the interstitial for this host (the tab's 'dangerous' state). */
  isBypassed(session: object, host: string): boolean {
    return sessionExceptions(session).has(host.toLowerCase())
  },
}

/** The mux layer: listed documents (pages and frames) are cancelled, and the tab is told why. */
export function safetyLayer(session: object): WebRequestHooks {
  return {
    onBeforeRequest(d: OnBeforeRequestListenerDetails) {
      if (d.resourceType !== 'mainFrame' && d.resourceType !== 'subFrame') return null
      if (!safety.blocks(session, d.url)) return null
      if (d.resourceType === 'mainFrame' && d.webContentsId !== undefined) blockedNavigations.note(d.webContentsId, d.url, 'dangerous')
      return { cancel: true }
    },
  }
}
