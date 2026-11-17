/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The query worker_threads entry: query_table's read runs
// here, so a slow statement never blocks the window, and main terminates
// the worker after the timeout. Its own main-process input in
// electron.vite.config.ts (out/main/tablesQueryWorker.js).
import { parentPort } from 'node:worker_threads'
import { runRead, type ReadRequest, type ReadResult } from './query'

// node:sqlite is still marked experimental; its one warning is expected here.
process.removeAllListeners('warning')

parentPort?.on('message', (request: ReadRequest) => {
  let result: ReadResult
  try {
    result = runRead(request)
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  parentPort?.postMessage(result)
})
