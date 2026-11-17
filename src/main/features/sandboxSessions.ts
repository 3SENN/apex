/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { session as electronSession, type Session } from 'electron'
import { permissionPolicy } from '../permissionPolicy'
import { webRequest, type LockdownAllow } from '../webRequest'

// The in-memory sandbox partitions: atelier-preprocess (the attachment
// pipeline's hidden image renderer) and atelier-artifacts (artifact tabs). Both
// are locked down through webRequest.lockdown and deny every permission.
// The lockdown takes effect once the webRequest mux is installed on the
// session (it runs through Feature.session; start-up passes these
// sessions through it too).

export const PREPROCESS_PARTITION = 'atelier-preprocess'

const sandboxes = new Map<string, Session>()

/** The partition's session, locked down on first use. `allow` defaults to refusing every request. */
export function sandboxSession(partition: string, allow: LockdownAllow = () => false): Session {
  const existing = sandboxes.get(partition)
  if (existing) return existing
  const session = electronSession.fromPartition(partition, { cache: false })
  webRequest.lockdown(session, allow)
  permissionPolicy.addOverride((r) => (r.session === session ? 'deny' : null))
  sandboxes.set(partition, session)
  return session
}

/** Every sandbox session made so far, for installSession (it installs the webRequest mux that enforces the lockdown). */
export function sandboxSessions(): { session: Session; partition: string }[] {
  return [...sandboxes].map(([partition, session]) => ({ session, partition }))
}
