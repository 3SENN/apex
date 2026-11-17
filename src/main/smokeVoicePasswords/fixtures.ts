/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SmokeServer } from '../smokeServer'

// The fixture pages: one registry over the smoke fixture server on
// 127.0.0.1 (the primary origin) and a second origin, http://localhost:<port>,
// so a page that frames the other is a real cross-site, out-of-process
// frame. Each part of the suite calls addFixture from its own smoke file.

export type FixtureOrigin = 'primary' | 'second'

export interface CrossSiteFixtures {
  /** http://127.0.0.1:<port> */
  primary: string
  /** http://localhost:<port>: another site, for cross-origin frames. */
  second: string
  /** Serves `html` at `path` on that origin and returns the page's full URL. */
  addFixture(path: string, html: string, origin?: FixtureOrigin): string
  close(): void
}

let current: { server: SmokeServer; fixtures: CrossSiteFixtures } | null = null

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

/** The fixtures for this smoke run, started on first use; the second origin stops with the process. */
export async function crossSiteFixtures(server: SmokeServer): Promise<CrossSiteFixtures> {
  if (current && current.server === server) return current.fixtures
  current?.fixtures.close()
  const pages = new Map<string, string>()
  const second = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const html = pages.get(url.pathname)
    if (html === undefined) res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  const port = await listen(second)
  second.unref()
  const secondBase = `http://localhost:${port}`
  const fixtures: CrossSiteFixtures = {
    primary: server.http,
    second: secondBase,
    addFixture: (path, html, origin = 'primary') => {
      const clean = path.startsWith('/') ? path : `/${path}`
      if (origin === 'second') pages.set(clean, html)
      else server.page(clean, html)
      return `${origin === 'second' ? secondBase : server.http}${clean}`
    },
    close: () => second.close(),
  }
  current = { server, fixtures }
  return fixtures
}

/** The smoke-only meeting URL pattern detection accepts: '<base>meet/<code>'. */
export function smokeMeetingUrl(base: string, code = 'abc-defg-hij'): string {
  return `${base.replace(/\/$/, '')}/meet/${code}`
}
