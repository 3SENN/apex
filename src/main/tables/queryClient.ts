/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { runRead, type ReadRequest, type ReadResult } from './query'

// Main's side of query_table's reads: one worker per query, terminated
// after the timeout, so a runaway statement costs nothing but its thread.
// Tests run the read in-process instead.

export const QUERY_TIMEOUT_MS = 15_000

export type ReadRunner = (req: ReadRequest, signal?: AbortSignal) => Promise<ReadResult>

export const inProcessReader: ReadRunner = async (req) => runRead(req)

export function workerReader(workerPath: () => string = () => join(__dirname, 'tablesQueryWorker.js'), timeoutMs = QUERY_TIMEOUT_MS): ReadRunner {
  return (req, signal) =>
    new Promise<ReadResult>((resolve) => {
      let worker: Worker
      const path = workerPath()
      // A build without the worker entry still answers, on this thread.
      if (!existsSync(path)) {
        resolve(runRead(req))
        return
      }
      try {
        worker = new Worker(path)
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
        return
      }
      let settled = false
      const finish = (result: ReadResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        void worker.terminate().catch(() => undefined)
        resolve(result)
      }
      const onAbort = (): void => finish({ ok: false, error: 'The query was stopped.' })
      const timer = setTimeout(() => finish({ ok: false, error: `The query took longer than ${timeoutMs / 1000} seconds and was stopped. Narrow it down and try again.` }), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (result: ReadResult) => finish(result))
      worker.once('error', (err) => finish({ ok: false, error: err.message }))
      worker.once('exit', () => finish({ ok: false, error: 'The query stopped unexpectedly.' }))
      worker.postMessage(req)
    })
}
