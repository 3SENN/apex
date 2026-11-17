/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The smoke fixture server: HTTP and HTTPS on 127.0.0.1, so no smoke
// check ever leaves the machine. Smoke files add their own pages
// with route(). HTTPS uses the self-signed fixture in tests/fixtures/tls
// (the certificate interstitial checks rely on it being untrusted); when the
// fixture is not there (a packaged run), https is null.

export type SmokeHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>

export interface SmokeServer {
  /** http://127.0.0.1:<port> */
  http: string
  /** https://127.0.0.1:<port>, or null without the TLS fixture. */
  https: string | null
  route(path: string, handler: SmokeHandler): void
  /** A static HTML page at `path`. */
  page(path: string, html: string): void
  close(): void
}

export function tlsFixtureDir(appPath: string): string {
  return process.env.APEX_SMOKE_TLS ?? join(appPath, 'tests', 'fixtures', 'tls')
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

export async function startSmokeServer(options: { tlsDir?: string } = {}): Promise<SmokeServer> {
  const routes = new Map<string, SmokeHandler>()
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    Promise.resolve(handler(req, res, url)).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(err instanceof Error ? err.message : String(err))
    })
  }
  const http = createHttpServer(handle)
  const httpPort = await listen(http)
  let https: Server | null = null
  let httpsPort: number | null = null
  const dir = options.tlsDir
  if (dir && existsSync(join(dir, 'cert.pem')) && existsSync(join(dir, 'key.pem'))) {
    https = createHttpsServer({ cert: readFileSync(join(dir, 'cert.pem')), key: readFileSync(join(dir, 'key.pem')) }, handle)
    httpsPort = await listen(https)
  }
  return {
    http: `http://127.0.0.1:${httpPort}`,
    https: httpsPort === null ? null : `https://127.0.0.1:${httpsPort}`,
    route: (path, handler) => {
      routes.set(path, handler)
    },
    page: (path, html) => {
      routes.set(path, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      })
    },
    close: () => {
      http.close()
      https?.close()
    },
  }
}
