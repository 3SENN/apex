/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { PdfResult } from './extract'
import type { PdfReply, PdfRequest } from './worker'

// Main's side of the pdf module: one worker thread per file, so a
// file that hangs pdf.js is simply terminated after the timeout. The intake
// uses it for PDF attachments and PDF tabs; the chat session can use it for PDF tabs the
// agent reads.

export type PdfReadResult = PdfResult | { ok: false; error: 'timeout' }

export interface PdfReader {
  read(bytes: Uint8Array, maxPages: number): Promise<PdfReadResult>
}

export const PDF_TIMEOUT_MS = 20_000

/** Reads PDFs in out/main/pdfWorker.js (or another worker script, for tests). */
export function workerPdfReader(workerPath: () => string = () => join(__dirname, 'pdfWorker.js'), timeoutMs = PDF_TIMEOUT_MS): PdfReader {
  return {
    read(bytes, maxPages) {
      return new Promise<PdfReadResult>((resolve) => {
        let worker: Worker
        try {
          worker = new Worker(workerPath())
        } catch {
          resolve({ ok: false, error: 'broken' })
          return
        }
        let settled = false
        const finish = (result: PdfReadResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          void worker.terminate().catch(() => undefined)
          resolve(result)
        }
        const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
        worker.once('message', (reply: PdfReply) => {
          const { id: _id, ...result } = reply
          finish(result)
        })
        worker.once('error', () => finish({ ok: false, error: 'broken' }))
        worker.once('exit', () => finish({ ok: false, error: 'broken' }))
        // A fresh copy: a Buffer's slice() shares Node's pool, which can't be transferred.
        const data = new Uint8Array(bytes).buffer
        const request: PdfRequest = { id: 1, data, maxPages }
        worker.postMessage(request, [data])
      })
    },
  }
}
