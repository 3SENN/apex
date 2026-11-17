/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ATTACHMENT_LIMITS } from '@shared/attachments'
import type { PdfReply, PdfRequest } from '../pdf/worker'

// The agent can read PDF tabs. Chromium's PDF viewer has no DOM the
// page bridge can walk, so get_page_text, find and read_page on a PDF tab
// fetch the bytes through the tab's own session (its cookies, its proxy) and
// extract the text with the pdf.js worker.

const PAGE_TEXT_MAX = 50_000
const FETCH_TIMEOUT_MS = 20_000
const WORKER_TIMEOUT_MS = 20_000

export interface PdfTabLike {
  view: {
    webContents: {
      getURL(): string
      executeJavaScript(code: string): Promise<unknown>
      session: { fetch(url: string, init?: { signal?: AbortSignal }): Promise<Response> }
    }
  }
}

export type PdfExtract = (bytes: Buffer, maxPages: number) => Promise<{ pages: number; text: string }>

/** Whether the tab shows a PDF: its URL names one, or the document says so. */
export async function isPdfTab(tab: PdfTabLike): Promise<boolean> {
  const url = tab.view.webContents.getURL()
  if (!/^https?:|^file:/i.test(url)) return false
  try {
    if (/\.pdf$/i.test(new URL(url).pathname)) return true
  } catch {
    return false
  }
  try {
    const type = await Promise.race([
      tab.view.webContents.executeJavaScript('document.contentType'),
      new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
    ])
    return type === 'application/pdf'
  } catch {
    return false
  }
}

/** Runs one extraction in the pdf.js worker (out/main/pdfWorker.js). */
export const workerExtract: PdfExtract = (bytes, maxPages) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'pdfWorker.js'))
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error('Reading the PDF took too long.'))
    }, WORKER_TIMEOUT_MS)
    worker.once('message', (reply: PdfReply) => {
      clearTimeout(timer)
      void worker.terminate()
      if (reply.ok) resolve({ pages: reply.pages, text: reply.text })
      else reject(new Error(reply.error))
    })
    worker.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const request: PdfRequest = { id: 1, data, maxPages }
    worker.postMessage(request, [data])
  })

/** Reads PDF tabs for the browser executor, caching the text per URL while the tab stays on it. */
export class PdfTabReader {
  readonly #extract: PdfExtract
  readonly #cache = new Map<string, { pages: number; text: string }>()

  constructor(extract: PdfExtract = workerExtract) {
    this.#extract = extract
  }

  isPdf(tab: PdfTabLike): Promise<boolean> {
    return isPdfTab(tab)
  }

  async text(tab: PdfTabLike): Promise<{ pages: number; text: string }> {
    const url = tab.view.webContents.getURL()
    const cached = this.#cache.get(url)
    if (cached) return cached
    const response = await tab.view.webContents.session.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`The PDF could not be loaded (${response.status}).`)
    const length = Number(response.headers.get('content-length') ?? 0)
    if (length > ATTACHMENT_LIMITS.pdfBytes) throw new Error('This PDF is larger than 32 MB, too large to read here.')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > ATTACHMENT_LIMITS.pdfBytes) throw new Error('This PDF is larger than 32 MB, too large to read here.')
    const result = await this.#extract(bytes, ATTACHMENT_LIMITS.pdfPages)
    if (this.#cache.size > 8) this.#cache.clear()
    this.#cache.set(url, result)
    return result
  }

  /** get_page_text and read_page: the text, capped like page text. */
  async pageText(tab: PdfTabLike): Promise<string> {
    const { pages, text } = await this.text(tab)
    return pdfPageText(pages, text)
  }

  /** find: the lines that mention the query, with their page. */
  async find(tab: PdfTabLike, query: string): Promise<string> {
    const { text } = await this.text(tab)
    return findInPdfText(text, query)
  }
}

export function pdfPageText(pages: number, text: string): string {
  const head = `This tab shows a PDF (${pages} page${pages === 1 ? '' : 's'}). It has no element references; read it as text.\n\n`
  const body = text.length > PAGE_TEXT_MAX ? `${text.slice(0, PAGE_TEXT_MAX)}\n…(cut at ${PAGE_TEXT_MAX} characters)` : text
  return head + (body.trim() || '(No text could be read from this PDF; it may be scanned images.)')
}

/** Matches by every word of the query, case-insensitive; page markers like "--- Page 3 ---" name the page. */
export function findInPdfText(text: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  if (words.length === 0) return 'Give a few words to look for.'
  let page = 1
  const hits: string[] = []
  for (const line of text.split('\n')) {
    const marker = /^-{2,}\s*page\s+(\d+)\s*-{2,}$/i.exec(line.trim())
    if (marker?.[1]) {
      page = Number(marker[1])
      continue
    }
    const lower = line.toLowerCase()
    if (words.some((w) => lower.includes(w))) hits.push(`Page ${page}: ${line.trim().slice(0, 300)}`)
    if (hits.length >= 20) break
  }
  return hits.length > 0 ? `This tab shows a PDF; matches by text (no element references):\n${hits.join('\n')}` : `No text in this PDF matches “${query}”.`
}
