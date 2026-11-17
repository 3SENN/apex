/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageKey } from '../i18n/useT'

// The renderer's platform helpers: which platform's wording to use, and a tiny channel
// so Settings can ask the layer to show the login-item approval dialog.

export type PlatformKind = 'mac' | 'win' | 'linux'

export function platformKind(platform: string): PlatformKind {
  return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
}

/** On Windows, in the chrome or a float window: for the `.win` wording of a string that says Mac. */
export function isWindows(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { apex?: { platform?: string }; apexFloat?: { platform?: string } }
  return (w.apex?.platform ?? w.apexFloat?.platform) === 'win32'
}

/** "Keep running in the menu bar / notification area / system tray". */
export function backgroundLabels(kind: PlatformKind): { label: MessageKey; description: MessageKey; quiet: MessageKey } {
  return {
    label: `system.general.background.${kind}`,
    description: `system.general.background.description.${kind}`,
    quiet: `system.general.openAtLogin.quiet.${kind}`,
  }
}

const listeners = new Set<() => void>()

/** Opens the approval dialog (SystemLayer listens). */
export function requestLoginItemApproval(): void {
  for (const fn of [...listeners]) fn()
}

export function onLoginItemApprovalRequest(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
