/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session, WebContents } from 'electron'

// Permission overrides. They run before the policy table in
// shared/permissions.ts: the extensions feature answers for chrome-extension://
// origins, and the sandbox partitions deny everything. The first non-null answer wins.

export interface PermissionOverrideRequest {
  origin: string
  permission: string
  session: Session
  webContents: WebContents | null
}

export type PermissionOverride = (r: PermissionOverrideRequest) => 'allow' | 'deny' | null

const overrides: PermissionOverride[] = []

export const permissionPolicy = {
  addOverride(fn: PermissionOverride): () => void {
    overrides.push(fn)
    return () => {
      const i = overrides.indexOf(fn)
      if (i >= 0) overrides.splice(i, 1)
    }
  },
  /** The first override's answer, or null to fall through to the policy table. */
  override(r: PermissionOverrideRequest): 'allow' | 'deny' | null {
    for (const fn of overrides) {
      const answer = fn(r)
      if (answer) return answer
    }
    return null
  },
}
