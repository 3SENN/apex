/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { app, protocol } from 'electron'
import { ARTIFACT_SCHEME, FILE_SCHEME } from '@shared/files'
import { APEX_APP_SCHEME } from '@shared/apps'
import { PACK_SCHEME } from '@shared/packs'

// Meeting audio and the mic test, served with Range, on the chrome and float sessions only
export const MEDIA_SCHEME = 'apex-media'

// The chrome UI is served from app://apex/ instead of file://, so the
// GrantFileProtocolExtraPrivileges fuse can stay off and the UI gets a real
// origin with a strict Content-Security-Policy.

export const APP_SCHEME = 'app'
export const APP_HOST = 'apex'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * The dev server's URL under `electron-vite dev`. A packaged app ignores it:
 * anyone who can set the launch environment could otherwise load the
 * privileged chrome UI, and its full IPC, from any page.
 */
export function devRendererUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Apex-file: serves the viewer's images and media.
  "img-src 'self' data: https: http: apex-file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // The pdf.js worker; one media-src directive, which apex-media: joins
  "worker-src 'self'",
  "media-src 'self' apex-file: apex-media:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/** Maps an app:// URL to a file under root, or null if it escapes root. */
export function resolveAppPath(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  const relative = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')
  const base = resolve(root)
  const target = resolve(base, relative)
  return target.startsWith(base + sep) ? target : null
}

/**
 * Every privileged scheme, registered in one registerSchemesAsPrivileged call
 * before ready: Electron honours only one call.
 */
export const PRIVILEGED_SCHEMES: Electron.CustomScheme[] = [
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  // The file viewer's files, with range requests, and artifact tabs
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } },
  // Agent-built apps, served from their own locked-down partition; never a secure-context peer of app://
  { scheme: APEX_APP_SCHEME, privileges: { standard: true, secure: true } },
  // ── packs privileged scheme ── (docs/packs.md: each pack's files from its own locked-down partition; standard, so pack code can import its own modules; stream, so an app's audio and video seek; codeCache, so a big game's scripts compile once, docs/apps.md)
  { scheme: PACK_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged(PRIVILEGED_SCHEMES)
}

export function handleAppProtocol(root: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(root, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        headers: {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// Apps are served only inside their own persist:apex-app-<id> partition, by src/main/apps/protocol.ts
/** What any other session answers for apex-app://: a plain page, never the app. */
export function apexAppElsewhere(): Response {
  const body = '<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>App</title><p style="font:15px system-ui;margin:40px">This app opens from Workspace › Apps.</p>'
  return new Response(body, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' } })
}

/** Registers that answer on a web, private or profile session (the apps feature calls it from Feature.session). */
export function handleApexAppElsewhere(session: Electron.Session): void {
  if (session.protocol.isProtocolHandled(APEX_APP_SCHEME)) return
  session.protocol.handle(APEX_APP_SCHEME, () => apexAppElsewhere())
}
