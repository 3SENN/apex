/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { webContents as allWebContents, type WebContents } from 'electron'
import { pendingPageDialogs } from './pageDialogs'
import { waitFor } from './smokeKit'

// Smoke: waits for a fixture tab to finish loading, and when it doesn't, says
// why: what the tab is doing, which renderer it shares, and any page there
// that is blocked on a dialog (a page dialog holds its whole renderer).

export function loadState(wc: WebContents): string {
  if (wc.isDestroyed()) return 'the tab is gone'
  const pid = wc.getOSProcessId()
  const sharing = allWebContents
    .getAllWebContents()
    .filter((o) => o.id !== wc.id && !o.isDestroyed() && o.getOSProcessId() === pid)
    .map((o) => o.getURL() || '(blank)')
  const blocked = pendingPageDialogs()
  return [
    `url ${wc.getURL() || '(none)'}`,
    `loading ${wc.isLoading()}, main frame ${wc.isLoadingMainFrame()}, waiting for response ${wc.isWaitingForResponse()}, crashed ${wc.isCrashed()}`,
    `pid ${pid}${sharing.length ? ` shared with ${sharing.slice(0, 4).join(', ')}` : ''}`,
    blocked.length ? `pages on a dialog: ${blocked.map((b) => `${b.url} (pid ${b.pid})`).join(', ')}` : 'no page on a dialog',
  ].join('; ')
}

/** Waits for `wc` to stop loading (and to satisfy `ready`, when given). */
export async function waitForPage(wc: WebContents, what: string, timeoutMs = 8000, ready: (url: string) => boolean = () => true): Promise<void> {
  await waitFor(() => !wc.isDestroyed() && !wc.isLoading() && ready(wc.getURL()), timeoutMs, what).catch((err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} (${loadState(wc)})`)
  })
}
