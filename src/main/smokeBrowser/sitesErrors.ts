/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type AddressInfo } from 'node:net'
import type { TabInfo } from '@shared/ipc'
import type { PageErrorDetails } from '@shared/safety'
import type { PageErrorKind } from '@shared/sites'
import { assert, waitFor } from '../smokeKit'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The site error pages' smoke checks and shots: a refused connection, the dangerous-
// site interstitial (from the bundled list, refused before any request
// leaves), the certificate interstitial on the fixture server's self-signed
// certificate with Proceed anyway, and a crashed tab coming back on Reload.
// Every address is local or refused locally; nothing reaches the network.

/**
 * A local port nothing listens on, so the connection is refused at once. Not a
 * well-known one: Chromium blocks ports like 9 as unsafe before connecting.
 */
let refusedUrl: string | null = null
async function REFUSED(): Promise<string> {
  if (refusedUrl) return refusedUrl
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  refusedUrl = `http://127.0.0.1:${port}/`
  return refusedUrl
}
const DANGEROUS_URL = 'https://dangerous.atelier.test/'

function info(ctx: SmokeContext, tab: Tab): TabInfo {
  return ctx.tabs.info(tab)
}

async function errorTab(ctx: SmokeContext, url: string, kind: PageErrorKind): Promise<Tab> {
  const tab = ctx.tabs.create(url, { activate: true })
  await waitFor(() => info(ctx, tab).pageError?.kind === kind, 10_000, `the ${kind} error page`)
  await ctx.chrome.until('return document.querySelector(".perr__title")?.textContent || null', 5000, 'the error page in the pane')
  return tab
}

const refused: SmokeCheck = {
  name: 'site errors: a refused connection shows Atelier’s error page, keeping the address',
  async run(ctx) {
    const REFUSED_URL = await REFUSED()
    const tab = await errorTab(ctx, REFUSED_URL, 'refused')
    try {
      const i = info(ctx, tab)
      assert(i.url.startsWith(REFUSED_URL), 'the failed address stays the tab’s URL')
      const details = await ctx.chrome.invoke<PageErrorDetails | null>('pageErrors', 'details', tab.id)
      assert(details?.codeName === 'ERR_CONNECTION_REFUSED', `the small print names the code (got ${details?.codeName ?? 'nothing'})`)
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

const dangerous: SmokeCheck = {
  name: 'site errors: a listed host shows the dangerous-site interstitial',
  async run(ctx) {
    const tab = await errorTab(ctx, DANGEROUS_URL, 'dangerous-site')
    try {
      const shown = await ctx.chrome.js<{ danger: boolean; primary: string }>(
        'return { danger: !!document.querySelector(".perr--danger"), primary: document.querySelector(".perr__actions button:last-child")?.textContent || "" }',
      )
      assert(shown.danger && shown.primary.length > 0, 'the danger page offers Back to safety')
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

const certificate: SmokeCheck = {
  name: 'site errors: a self-signed certificate gets the interstitial, and Proceed anyway lets it through for the session',
  async run(ctx) {
    if (!ctx.server.https) return
    ctx.server.page('/sites-errors-cert', '<!doctype html><title>Certificate fixture</title><p>Through.</p>')
    const url = `${ctx.server.https}/sites-errors-cert`
    const tab = await errorTab(ctx, url, 'certificate')
    try {
      const details = await ctx.chrome.invoke<PageErrorDetails | null>('pageErrors', 'details', tab.id)
      assert(details?.certificate?.sha256.includes(':'), 'the interstitial has the offered certificate’s fingerprint')
      assert(info(ctx, tab).security === 'insecure', 'the pill shows the connection as not secure')
      // Shot here, before Proceed anyway: afterwards the host is let through for the session.
      if (process.env.ATELIER_SMOKE_SHOTS) {
        await ctx.chrome.js('document.querySelector(".perr__toggle")?.click(); return true')
        await ctx.shot('sites-error-certificate')
      }
      await ctx.chrome.invoke('pageErrors', 'proceed', tab.id)
      await waitFor(() => info(ctx, tab).pageError === null && !info(ctx, tab).loading, 10_000, 'the page to load after Proceed anyway')
      assert(info(ctx, tab).security === 'cert-bypassed', `the pill remembers the bypass (got ${info(ctx, tab).security})`)
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

const crashed: SmokeCheck = {
  name: 'site errors: a crashed tab says so and comes back on Reload',
  async run(ctx) {
    ctx.server.page('/sites-errors-crash', '<!doctype html><title>Crash fixture</title><p>Alive.</p>')
    const tab = ctx.tabs.create(`${ctx.server.http}/sites-errors-crash`, { activate: true })
    try {
      await waitFor(() => !info(ctx, tab).loading && info(ctx, tab).url.endsWith('/sites-errors-crash'), 10_000, 'the fixture page')
      const wc = tab.view.webContents
      // macOS and Windows end the renderer from main at once; on Linux forcefullyCrashRenderer asks the
      // renderer to crash itself, and the crash (with the system's crash handling) can take seconds on a
      // loaded machine. So wait for the renderer to be gone, however long the platform takes, then give
      // the tab the usual moment to say so.
      let gone: string | null = null
      wc.once('render-process-gone', (_event, details) => {
        gone = details.reason
      })
      wc.forcefullyCrashRenderer()
      // A sandboxed renderer on a Linux CI runner may never act on the request: then it is ended from
      // outside, as a crash looks to Atelier (anything but a clean exit). On a Mac it is gone at once.
      await waitFor(() => gone !== null || wc.isCrashed(), 5000, 'the renderer to go after forcefullyCrashRenderer').catch(() => {
        const pid = wc.getOSProcessId()
        if (pid > 0) process.kill(pid, 'SIGKILL')
      })
      await waitFor(() => gone !== null || wc.isCrashed(), 30_000, 'the renderer to go')
      await waitFor(() => info(ctx, tab).crashed, 3000, `the tab to report its crash (the renderer went: ${gone ?? 'crashed'})`)
      await ctx.chrome.until('return document.querySelector(".perr__title")?.textContent || null', 5000, 'the crashed page in the pane')
      await ctx.chrome.invoke('pageErrors', 'retry', tab.id)
      await waitFor(() => !info(ctx, tab).crashed && !info(ctx, tab).loading, 10_000, 'the tab to come back')
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

export const errorChecks: SmokeCheck[] = [refused, dangerous, certificate, crashed]

function errorShot(name: string, url: (ctx: SmokeContext) => string | null | Promise<string | null>, kind: PageErrorKind, openDetails = false): ShotSpec {
  return {
    name,
    async run(ctx) {
      const target = await url(ctx)
      if (!target) return
      const tab = await errorTab(ctx, target, kind)
      try {
        if (openDetails) await ctx.chrome.js('document.querySelector(".perr__toggle")?.click(); return true')
        await ctx.shot(name)
      } finally {
        ctx.tabs.close(tab.id)
      }
    },
  }
}

export const errorShots: ShotSpec[] = [
  errorShot('sites-error-refused', () => REFUSED(), 'refused'),
  errorShot('sites-error-dangerous', () => DANGEROUS_URL, 'dangerous-site', true),
]
