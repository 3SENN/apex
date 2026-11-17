/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pdf.js worker_threads entry: text and page counts for PDF
// attachments and PDF tabs, on the legacy build (pdf.js 6 never
// evaluates code). It is its own main-process input in
// electron.vite.config.ts (out/main/pdfWorker.js); client.ts starts one per
// file and kills it after the timeout.
import Module from 'node:module'
import { parentPort } from 'node:worker_threads'
import { extractPdf, type PdfFailure } from './extract'

// pdf.js loads the native @napi-rs/canvas in Node to draw pages, which
// reading text never does. Loaded in this worker it brought Electron down on
// Linux (SIGTRAP), so it is kept out on every platform; pdf.js warns and goes
// on without it.
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string }
const resolveFilename = loader._resolveFilename.bind(loader)
loader._resolveFilename = (request, ...rest) => {
  if (request === '@napi-rs/canvas' || request.startsWith('@napi-rs/canvas/')) throw new Error('Not used for reading PDF text.')
  return resolveFilename(request, ...rest)
}

export interface PdfRequest {
  id: number
  /** The PDF's bytes; transferred, not copied. */
  data: ArrayBuffer
  maxPages: number
}

export type PdfReply = { id: number; ok: true; pages: number; text: string } | { id: number; ok: false; error: PdfFailure; pages?: number }

parentPort?.on('message', (request: PdfRequest) => {
  void extractPdf(new Uint8Array(request.data), request.maxPages).then(
    (result) => parentPort?.postMessage({ id: request.id, ...result } satisfies PdfReply),
    () => parentPort?.postMessage({ id: request.id, ok: false, error: 'broken' } satisfies PdfReply),
  )
})
