/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { extname, relative, sep } from 'node:path'
import { BrowserWindow, type Session, type WebContents } from 'electron'
import { ATTACHMENT_LIMITS } from '@shared/attachments'
import { APP_ORIGIN, APP_SCHEME, resolveAppPath } from '../appProtocol'
import { log } from '../log'
import type { ImageProcessor, ImageResult } from './prepare'

// Main's side of the hidden preprocessing renderer: one
// offscreen, sandboxed window with no preload, in the in-memory partition
// atelier-preprocess, whose every network request is cancelled. Main hands it
// bytes through executeJavaScript and gets re-encoded images back, so
// decoding untrusted images and SVGs never happens in main.

/** The page's own policy: its scripts, blob and data images, its pdf.js worker; nothing else. */
export const PREPROCESS_CSP = "default-src 'none'; script-src 'self'; img-src blob: data:; worker-src 'self'"

const PAGE = 'preprocess.html'
const JOB_TIMEOUT_MS = 30_000
const IDLE_CLOSE_MS = 60_000

/**
 * What the preprocess partition may load: its page and bundled assets, blob
 * and data URLs; in development also the dev server. Everything else, every
 * http(s) request included, is cancelled.
 */
export function preprocessAllow(url: string, devOrigin?: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true
  if (url === `${APP_ORIGIN}/${PAGE}` || url.startsWith(`${APP_ORIGIN}/assets/`)) return true
  if (devOrigin) {
    try {
      const u = new URL(url)
      return `${u.protocol === 'ws:' ? 'http:' : u.protocol === 'wss:' ? 'https:' : u.protocol}//${u.host}` === devOrigin
    } catch {
      return false
    }
  }
  return false
}

/** The file app:// serves in the preprocess partition: only the page and its assets. */
export function preprocessFile(root: string, url: string): string | null {
  const file = resolveAppPath(root, url)
  if (!file) return null
  const rel = relative(root, file).split(sep).join('/')
  return rel === PAGE || rel.startsWith('assets/') ? file : null
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
}

interface PreprocessDeps {
  session: Session
  /** out/renderer, where preprocess.html and its assets are built. */
  rendererRoot: string
  /** The dev server (electron-vite dev), never in a packaged app. */
  devUrl?: string
}

type Wire = { base64: string; mediaType: string; width: number; height: number; thumbnail: string }

export function createPreprocessor(deps: PreprocessDeps): ImageProcessor {
  let window: BrowserWindow | null = null
  let ready: Promise<WebContents> | null = null
  let jobs = 0
  let idle: NodeJS.Timeout | null = null
  let protocolReady = false

  const serve = (): void => {
    if (protocolReady || deps.devUrl) return
    protocolReady = true
    deps.session.protocol.handle(APP_SCHEME, async (request) => {
      const file = preprocessFile(deps.rendererRoot, request.url)
      if (!file) return new Response('Not found', { status: 404 })
      try {
        return new Response(await readFile(file), {
          headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-security-policy': PREPROCESS_CSP, 'x-content-type-options': 'nosniff' },
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  const close = (): void => {
    if (idle) clearTimeout(idle)
    idle = null
    const w = window
    window = null
    ready = null
    if (w && !w.isDestroyed()) w.destroy()
  }

  const open = (): Promise<WebContents> => {
    if (ready) return ready
    serve()
    const w = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        session: deps.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        webgl: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      },
    })
    window = w
    const wc = w.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event) => event.preventDefault())
    wc.on('render-process-gone', (_event, details) => {
      log.warn('intake', 'The preprocessing renderer went away', { reason: details.reason })
      if (window === w) close()
    })
    const url = deps.devUrl ? `${deps.devUrl}/${PAGE}` : `${APP_ORIGIN}/${PAGE}`
    ready = wc.loadURL(url).then(async () => {
      const version: unknown = await wc.executeJavaScript('globalThis.atelierPreprocess && globalThis.atelierPreprocess.version', true)
      if (version !== 1) throw new Error('preprocess page not ready')
      return wc
    })
    ready.catch(() => {
      if (window === w) close()
    })
    return ready
  }

  /** Runs one call in the page, with a timeout; the window closes after a minute without work. */
  const run = async <T>(method: string, input: unknown): Promise<T> => {
    jobs++
    if (idle) clearTimeout(idle)
    idle = null
    try {
      const wc = await open()
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('preprocess timed out')), JOB_TIMEOUT_MS)
      })
      try {
        return await Promise.race([wc.executeJavaScript(`globalThis.atelierPreprocess.${method}(${JSON.stringify(input)})`, true) as Promise<T>, timeout])
      } finally {
        clearTimeout(timer)
      }
    } finally {
      jobs--
      if (jobs === 0 && window) idle = setTimeout(close, IDLE_CLOSE_MS)
    }
  }

  const toResult = (wire: Wire): ImageResult => ({
    bytes: Buffer.from(wire.base64, 'base64'),
    mediaType: wire.mediaType === 'image/png' ? 'image/png' : 'image/jpeg',
    width: wire.width,
    height: wire.height,
    thumbnail: wire.thumbnail || null,
  })

  return {
    async prepareImage(bytes, mediaType) {
      const wire = await run<Wire>('prepareImage', { base64: Buffer.from(bytes).toString('base64'), mediaType, longEdge: ATTACHMENT_LIMITS.imageLongEdge, maxPixels: ATTACHMENT_LIMITS.imageMaxPixels })
      return toResult(wire)
    },
    async rasterizeSvg(text) {
      const wire = await run<Wire>('rasterizeSvg', { text, longEdge: ATTACHMENT_LIMITS.imageLongEdge, maxPixels: ATTACHMENT_LIMITS.imageMaxPixels })
      return toResult(wire)
    },
    async pdfThumbnail(bytes) {
      const out = await run<{ thumbnail: string }>('pdfThumbnail', { base64: Buffer.from(bytes).toString('base64') })
      return out.thumbnail || null
    },
    dispose: close,
  }
}
