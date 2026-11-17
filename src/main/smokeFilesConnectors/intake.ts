/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { BrowserWindow, nativeImage, webContents, type WebContents } from 'electron'
import { fitWithin, type AttachmentRef, type AttachmentSource } from '@shared/attachments'
import { intakeSmokeHooks } from '../features/intake'
import { PREPROCESS_PARTITION, sandboxSession } from '../features/sandboxSessions'
import { mainT } from '../i18n/mainT'
import { exifSegment, hasExif, hasGps, insertSegment } from '../intake/exif'
import { assert, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { brokenPdf, buildPdf, executableBytes, SVG_FIXTURE } from './intakeFixtures'

// Attachments (EXIF, SVG, PDF pages, refusals), send waits, long
// paste, @ tab content and dragged page images, pages in this chat, and the
// locked-down preprocessing renderer. The renderer path the unit tests
// leave out runs here for real. Offline only: fixture pages on 127.0.0.1.

type Running = NonNullable<ReturnType<typeof intakeSmokeHooks>>

function intake(): Running {
  const running = intakeSmokeHooks()
  assert(running, 'the intake is running')
  return running
}

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** A solid BGRA bitmap of the given size, as JPEG or PNG bytes. */
function picture(width: number, height: number, format: 'jpeg' | 'png'): Buffer {
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0x88
    pixels[i + 1] = 0x55
    pixels[i + 2] = 0x22
    pixels[i + 3] = 0xff
  }
  const image = nativeImage.createFromBitmap(pixels, { width, height })
  return format === 'jpeg' ? image.toJPEG(90) : image.toPNG()
}

/** Adds a source to a fresh chat and waits until it is ready or failed. */
async function settle(chatId: string, source: AttachmentSource): Promise<AttachmentRef> {
  const { store } = intake()
  const added = store.add(chatId, source)
  // add() answers at once; only a refusal it can make without reading (size, count) is already failed.
  assert(added.state !== 'ready' || added.kind === 'paste', `a new attachment starts preparing (was ${added.state})`)
  const [done] = await Promise.race([
    store.settled(chatId, [added.id]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`attachment ${added.name} did not settle in 40 s`)), 40_000)),
  ])
  assert(done, 'the attachment is still listed')
  return done
}

/** The hidden preprocessing renderer's web contents, once it has run a job. */
function preprocessContents(): WebContents | undefined {
  const session = sandboxSession(PREPROCESS_PARTITION)
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.session === session)
}

/** Counts requests to a fixture path, so a check can prove nothing reached it. */
function counter(ctx: SmokeContext, path: string): { url: string; hits: () => number } {
  let hits = 0
  ctx.server.route(path, (_req, res) => {
    hits++
    res.writeHead(200, { 'content-type': 'text/plain' }).end('reached')
  })
  return { url: `${ctx.server.http}${path}`, hits: () => hits }
}

async function openTab(ctx: SmokeContext, url: string): Promise<string> {
  const tab = ctx.tabs.create(url, { activate: false })
  await waitFor(() => !tab.view.webContents.isLoading() && tab.view.webContents.getURL().startsWith(url), 10_000, `${url} to load`)
  return tab.id
}

export const checks: SmokeCheck[] = [
  {
    name: 'a photo is turned upright, downscaled, and loses its EXIF and GPS',
    async run() {
      const chatId = randomUUID()
      const { store } = intake()
      try {
        const tagged = insertSegment(picture(2000, 1000, 'jpeg'), exifSegment({ orientation: 6, gps: true }))
        assert(hasExif(tagged) && hasGps(tagged), 'the fixture photo carries EXIF and GPS')
        const ref = await settle(chatId, { type: 'file', name: 'harbour.jpg', base64: base64(tagged) })
        assert(ref.state === 'ready', `the photo is ready (${ref.error ?? ref.state})`)
        assert(ref.kind === 'image' && ref.mediaType === 'image/jpeg', `an opaque photo stays JPEG (${ref.mediaType})`)
        assert(ref.thumbnail?.startsWith('data:image/'), 'the photo has a thumbnail')
        const file = store.file(chatId, ref.id)
        assert(file?.preparedPath && existsSync(file.preparedPath), 'the prepared photo is on disk')
        const prepared = readFileSync(file.preparedPath)
        assert(!hasExif(prepared) && !hasGps(prepared), 'the prepared photo has no EXIF or GPS')
        const size = nativeImage.createFromBuffer(prepared).getSize()
        const want = fitWithin(1000, 2000)
        assert(Math.abs(size.width - want.width) <= 1 && Math.abs(size.height - want.height) <= 1, `the photo is upright and within 1568 px and 1.15 MP (got ${size.width}x${size.height}, want ${want.width}x${want.height})`)
        const [resolved] = store.resolve(chatId, [ref.id])
        assert(resolved?.payload.type === 'image' && resolved.payload.mediaType === 'image/jpeg', 'the photo resolves as an image block')
      } finally {
        store.removeChat(chatId)
      }
    },
  },
  {
    name: 'a transparent PNG stays PNG; an SVG becomes a PNG without running its script',
    async run() {
      const chatId = randomUUID()
      const { store } = intake()
      try {
        const pixels = Buffer.alloc(32 * 32 * 4) // every pixel fully transparent
        const clear = nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }).toPNG()
        const png = await settle(chatId, { type: 'file', name: 'mark.png', base64: base64(clear) })
        assert(png.state === 'ready' && png.mediaType === 'image/png', `a PNG with alpha stays PNG (${png.error ?? png.mediaType})`)

        const svg = await settle(chatId, { type: 'file', name: 'badge.svg', base64: Buffer.from(SVG_FIXTURE).toString('base64') })
        assert(svg.state === 'ready', `the SVG is ready (${svg.error ?? svg.state})`)
        // The ref keeps the original type (as HEIC does); what the model gets is the prepared PNG.
        assert(svg.kind === 'image', `the SVG is an image attachment (${svg.kind})`)
        const file = store.file(chatId, svg.id)
        assert(file?.originalPath && existsSync(file.originalPath), 'the SVG original is kept for the viewer')
        assert(file.preparedPath && existsSync(file.preparedPath), 'the SVG has a prepared PNG')
        assert(readFileSync(file.preparedPath).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'the SVG is rasterized to PNG')
        const size = nativeImage.createFromBuffer(readFileSync(file.preparedPath)).getSize()
        // A small vector is drawn up to a legible size (SVG_TARGET_EDGE), keeping its shape.
        assert(size.width >= 40 && size.width === size.height * 2, `the PNG keeps the SVG's 2:1 shape (got ${size.width}x${size.height})`)
        const wc = preprocessContents()
        assert(wc, 'the preprocessing renderer ran the job')
        const ran = await wc.executeJavaScript('typeof globalThis.ran', true)
        assert(ran === 'undefined', "the SVG's script never ran")
      } finally {
        store.removeChat(chatId)
      }
    },
  },
  {
    name: 'PDFs report their pages and a thumbnail; encrypted, broken and unknown files fail with a reason',
    async run() {
      const chatId = randomUUID()
      const { store } = intake()
      try {
        const pdf = await settle(chatId, { type: 'file', name: 'tides.pdf', base64: base64(buildPdf(3)) })
        assert(pdf.state === 'ready' && pdf.kind === 'pdf', `the PDF is ready (${pdf.error ?? pdf.state})`)
        assert(pdf.pages === 3, `the PDF reports 3 pages (got ${pdf.pages})`)
        assert(pdf.thumbnail?.startsWith('data:image/'), 'the PDF has a first-page thumbnail')
        const [resolved] = store.resolve(chatId, [pdf.id])
        assert(resolved?.payload.type === 'pdf' && resolved.payload.text.includes('Page 2 of the fixture'), 'the PDF text is extracted with its pages')

        const locked = await settle(chatId, { type: 'file', name: 'locked.pdf', base64: base64(buildPdf(1, { encrypted: true })) })
        assert(locked.state === 'failed' && locked.error === mainT('intake.reason.pdfEncrypted'), `an encrypted PDF is refused (${locked.error})`)
        const broken = await settle(chatId, { type: 'file', name: 'broken.pdf', base64: base64(brokenPdf()) })
        assert(broken.state === 'failed' && broken.error === mainT('intake.reason.pdfBroken'), `a broken PDF is refused (${broken.error})`)
        const renamed = await settle(chatId, { type: 'file', name: 'notes.txt', base64: base64(executableBytes()) })
        assert(renamed.state === 'failed' && renamed.error === mainT('intake.reason.unsupported'), `a renamed program is refused by its bytes (${renamed.error})`)
        // Try again reruns from the saved original, so the same refusal comes back.
        intake().services.attachments.retry(chatId, locked.id)
        const [retried] = await store.settled(chatId, [locked.id])
        assert(retried?.state === 'failed' && retried.error === mainT('intake.reason.pdfEncrypted'), `Try again reruns the saved original (${retried?.error})`)
      } finally {
        store.removeChat(chatId)
      }
    },
  },
  {
    name: 'a long paste is a text chip with its counts, and edits recount it (CH-24)',
    async run() {
      const chatId = randomUUID()
      const { store, services } = intake()
      try {
        const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
        const paste = await settle(chatId, { type: 'paste', text })
        assert(paste.state === 'ready' && paste.kind === 'paste', `the paste is ready (${paste.error ?? paste.state})`)
        assert(paste.lines === 40, `the paste counts 40 lines (got ${paste.lines})`)
        const edited = services.attachments.updateText(chatId, paste.id, `${text}\nline 41`)
        assert(edited.lines === 41, `an edit recounts the lines (got ${edited.lines})`)
        assert(services.attachments.readText(chatId, paste.id).endsWith('line 41'), 'the preview editor reads the edited text')
        store.bindToMessage(chatId, [paste.id], randomUUID())
        let frozen = false
        try {
          services.attachments.updateText(chatId, paste.id, 'changed after sending')
        } catch {
          frozen = true
        }
        assert(frozen, 'a sent paste can no longer be edited')
      } finally {
        store.removeChat(chatId)
      }
    },
  },
  {
    name: "@tab attaches the page's text, and the page joins this chat's pages (CH-25, CH-34)",
    async run(ctx) {
      const chatId = randomUUID()
      const { store, services } = intake()
      ctx.server.page('/c-l1/article', '<!doctype html><html><head><title>Harbour notes</title></head><body><main><h1>Harbour notes</h1><p>High water on Thursday is at 06:40.</p></main></body></html>')
      const url = `${ctx.server.http}/c-l1/article`
      const tabId = await openTab(ctx, url)
      try {
        const ref = await settle(chatId, { type: 'tab', tabId })
        assert(ref.state === 'ready' && ref.kind === 'tab', `the tab is ready (${ref.error ?? ref.state})`)
        assert(ref.source?.url === url && ref.source.title === 'Harbour notes', 'the tab keeps its URL and title')
        const [resolved] = store.resolve(chatId, [ref.id])
        assert(resolved?.payload.type === 'text' && resolved.payload.text.includes('06:40'), "the tab resolves to the page's text")
        const pages = services.chatContext.list(chatId)
        const page = pages.find((p) => p.tabId === tabId)
        assert(page?.source === 'attached' && page.inContext, 'the attached tab is listed in this chat, in context')
        services.chatContext.remove(chatId, tabId)
        assert(!services.chatContext.list(chatId).some((p) => p.tabId === tabId), 'a page the agent does not control can be removed')
      } finally {
        store.removeChat(chatId)
        ctx.tabs.close(tabId)
      }
    },
  },
  {
    name: 'a dragged page image is fetched through its tab, with a content-type check',
    async run(ctx) {
      const chatId = randomUUID()
      const { store } = intake()
      const png = picture(64, 48, 'png')
      ctx.server.route('/c-l1/drop.png', (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) }).end(png)
      })
      ctx.server.route('/c-l1/drop.bin', (_req, res) => {
        const bytes = Buffer.from(executableBytes())
        res.writeHead(200, { 'content-type': 'application/x-mach-binary', 'content-length': String(bytes.length) }).end(bytes)
      })
      ctx.server.page('/c-l1/gallery', '<!doctype html><title>Gallery</title><img src="/c-l1/drop.png" alt="">')
      const tabId = await openTab(ctx, `${ctx.server.http}/c-l1/gallery`)
      try {
        const image = await settle(chatId, { type: 'page-url', tabId, url: `${ctx.server.http}/c-l1/drop.png` })
        assert(image.state === 'ready' && image.kind === 'image', `the dragged image is ready (${image.error ?? image.state})`)
        const other = await settle(chatId, { type: 'page-url', tabId, url: `${ctx.server.http}/c-l1/drop.bin` })
        assert(other.state === 'failed' && other.error === mainT('intake.reason.unsupported'), `a dragged program is refused (${other.error})`)
      } finally {
        store.removeChat(chatId)
        ctx.tabs.close(tabId)
      }
    },
  },
  {
    name: 'the preprocessing partition reaches no network, and its renderer has no Node',
    async run(ctx) {
      const probe = counter(ctx, '/c-l1/ping')
      const win = new BrowserWindow({ show: false, webPreferences: { partition: PREPROCESS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      try {
        let blocked = false
        try {
          await win.loadURL(probe.url)
        } catch {
          blocked = true
        }
        assert(blocked && probe.hits() === 0, 'a page load in atelier-preprocess is cancelled before it leaves')
      } finally {
        win.destroy()
      }
      // Make sure the hidden renderer is up, then ask it to fetch and to reach Node.
      const chatId = randomUUID()
      const { store } = intake()
      try {
        await settle(chatId, { type: 'file', name: 'dot.png', base64: base64(picture(8, 8, 'png')) })
        const wc = preprocessContents()
        assert(wc, 'the preprocessing renderer is running')
        const result = await wc.executeJavaScript(`fetch(${JSON.stringify(probe.url)}).then(() => 'reached', () => 'blocked')`, true)
        assert(result === 'blocked' && probe.hits() === 0, `the preprocessing renderer cannot fetch (${result})`)
        const node = await wc.executeJavaScript('[typeof require, typeof process, typeof window.atelier].join()', true)
        assert(node === 'undefined,undefined,undefined', `the preprocessing renderer has no Node or preload (${node})`)
      } finally {
        store.removeChat(chatId)
      }
    },
  },
]

// Intake is main-side with no surface of its own; the composer checks shoot the chips and previews.
export const shots: ShotSpec[] = []
