/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page counts and text for PDFs, on pdf.js's legacy build. pdf.js 6
// never evaluates code (its old isEvalSupported switch is gone), and fonts,
// WebAssembly decoders and fetches stay off. It runs inside the pdf worker
// thread (worker.ts), never on main's own thread, so a hostile or huge file
// can only stall the worker, and the client kills that after its timeout.

export type PdfFailure = 'encrypted' | 'broken' | 'too-many-pages'

export type PdfResult = { ok: true; pages: number; text: string } | { ok: false; error: PdfFailure; pages?: number }

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjs: Promise<PdfJs> | null = null
const load = (): Promise<PdfJs> => (pdfjs ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

/** The marker before each page's text, so the model can cite pages. */
export const pageMarker = (page: number): string => `--- Page ${page} ---`

export async function extractPdf(data: Uint8Array, maxPages: number): Promise<PdfResult> {
  const lib = await load()
  // pdf.js takes ownership of the buffer; hand it a copy so the caller's stays usable.
  const task = lib.getDocument({
    data: data.slice(),
    disableFontFace: true,
    useWasm: false,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    // An owner-password file opens without a prompt, but the API refuses encrypted PDFs.
    const { info } = await doc.getMetadata().catch(() => ({ info: null }))
    if ((info as { EncryptFilterName?: string | null } | null)?.EncryptFilterName) return { ok: false, error: 'encrypted' }
    if (doc.numPages > maxPages) return { ok: false, error: 'too-many-pages', pages: doc.numPages }
    const parts: string[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      parts.push(`${pageMarker(n)}\n${text.trim()}`)
      page.cleanup()
    }
    return { ok: true, pages: doc.numPages, text: parts.join('\n\n') }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    return { ok: false, error: name === 'PasswordException' ? 'encrypted' : 'broken' }
  } finally {
    await task.destroy().catch(() => undefined)
  }
}
