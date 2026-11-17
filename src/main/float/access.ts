/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { floatMayCall, type FloatKind } from '@shared/float'

// Who may call what from a floating window. Each float runs Apex's own page
// in a sandbox, but it still only gets the few methods its kind needs, and
// only from its own main frame: a stray frame or another window is refused.

export interface FloatSender {
  /** webContents id of the caller. */
  senderId: number
  /** The call came from the caller's main frame. */
  mainFrame: boolean
}

export type FloatAccess = { ok: true; kind: FloatKind } | { ok: false; error: string }

/**
 * Checks a float invoke: the sender must be the open window of some kind,
 * calling from its main frame, and the method must be on that kind's list.
 */
export function checkFloatAccess(owners: ReadonlyMap<number, FloatKind>, sender: FloatSender, method: unknown): FloatAccess {
  const kind = owners.get(sender.senderId)
  if (!kind || !sender.mainFrame) return { ok: false, error: 'Rejected IPC from an untrusted sender.' }
  if (typeof method !== 'string' || method.length > 80) return { ok: false, error: 'Unknown float method.' }
  if (!floatMayCall(kind, method)) return { ok: false, error: `The ${kind} window may not call ${method}.` }
  return { ok: true, kind }
}

/** 'voice.status' -> service call; 'card:action' -> a handler the owning feature registered. */
export function parseFloatMethod(method: string): { kind: 'service'; service: string; method: string } | { kind: 'local'; name: string } {
  const dot = method.indexOf('.')
  if (dot > 0 && !method.includes(':')) return { kind: 'service', service: method.slice(0, dot), method: method.slice(dot + 1) }
  return { kind: 'local', name: method }
}
