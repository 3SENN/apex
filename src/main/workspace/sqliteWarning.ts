/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// node:sqlite prints one ExperimentalWarning when it first loads. db.ts
// imports this module before node:sqlite so that warning (and only that
// one) is dropped; every other warning still reaches the default handler.

const original = process.emitWarning.bind(process) as (...args: unknown[]) => void

process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : ''
  const option = rest[0]
  const type = typeof option === 'string' ? option : ((option as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : ''))
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return
  original(warning, ...rest)
}) as typeof process.emitWarning

export {}
