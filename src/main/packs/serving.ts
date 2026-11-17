/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pages whose app runs a web server now (apex.server), by webContents id:
// such a tab never sleeps, or its server (and every phone on it) would stop.
// A module of its own, so the tabs feature reads it without loading packs.
const serving = new Set<number>()

export function markServing(contentsId: number, on: boolean): void {
  if (on) serving.add(contentsId)
  else serving.delete(contentsId)
}

export function isServing(contentsId: number): boolean {
  return serving.has(contentsId)
}
