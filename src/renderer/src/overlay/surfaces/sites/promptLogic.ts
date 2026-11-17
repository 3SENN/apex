/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure helpers for the permission prompt and the address bar's permission
// chips: how long a fresh prompt ignores presses, which keys do anything,
// how the asking origin reads, and which chips a page load shows. No DOM,
// so it is unit-tested.
import type { MessageKey } from '@shared/i18n/core'
import type { PermissionActivity, SitePermission } from '@shared/sites'
import { mediaNoun } from './logic'

/**
 * A prompt ignores presses on its answers for this long after it shows (and
 * after it shows again), so a page can't time a prompt under a click or a key
 * the person meant for the page (Chrome's input protection).
 */
export const PROMPT_INPUT_DELAY_MS = 500

/** Whether a press on an answer counts: only once the prompt has been on screen for the delay. */
export function inputArmed(shownAt: number | null, now: number, delay = PROMPT_INPUT_DELAY_MS): boolean {
  return shownAt !== null && now - shownAt >= delay
}

/** What a key does on the prompt. Esc puts it away undecided; Enter and every other key do nothing, so typing can't answer it. */
export function promptKeyAction(key: string): 'dismiss' | null {
  return key === 'Escape' ? 'dismiss' : null
}

const LOOPBACK = /^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i

/**
 * The asking origin as people should read it: the host,
 * with the scheme when it isn't https and the port when it isn't the default.
 * `notSecure` marks plain http that isn't this computer.
 */
export function promptOrigin(origin: string): { text: string; notSecure: boolean } {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return { text: origin, notSecure: false }
  }
  if (!url.host) return { text: origin, notSecure: false }
  // URL drops a default port by itself, so `host` carries only one that matters.
  const scheme = url.protocol === 'https:' ? '' : `${url.protocol}//`
  return { text: `${scheme}${url.host}`, notSecure: url.protocol === 'http:' && !LOOPBACK.test(url.hostname) }
}

export type PermissionChipKind = 'quiet' | 'macos' | 'blocked'

export interface PermissionChip {
  kind: PermissionChipKind
  origin: string
  perms: SitePermission[]
}

const CHIP_ORDER: readonly PermissionChipKind[] = ['quiet', 'macos', 'blocked']
const KIND_OF: Record<PermissionActivity['outcome'], PermissionChipKind> = { quiet: 'quiet', 'blocked-by-macos': 'macos', blocked: 'blocked' }

/**
 * The address bar's chips for a page load: a quiet request first (it waits for
 * an answer), then what macOS has turned off (it has a fix), then what was
 * refused. One chip per kind; a permission macOS blocked isn't listed again as
 * refused.
 */
export function permissionChips(activity: readonly PermissionActivity[]): PermissionChip[] {
  const byKind = new Map<PermissionChipKind, PermissionChip>()
  for (const a of activity) {
    const kind = KIND_OF[a.outcome]
    if (!kind) continue
    const chip = byKind.get(kind) ?? { kind, origin: a.origin, perms: [] }
    if (!chip.perms.includes(a.permission)) chip.perms.push(a.permission)
    byKind.set(kind, chip)
  }
  const macos = byKind.get('macos')
  const blocked = byKind.get('blocked')
  if (macos && blocked) {
    blocked.perms = blocked.perms.filter((p) => !macos.perms.includes(p))
    if (blocked.perms.length === 0) byKind.delete('blocked')
  }
  return CHIP_ORDER.flatMap((k) => byKind.get(k) ?? [])
}

/** The macOS privacy pane that turns a blocked permission back on; null when there is none to open. */
export function macosPane(perms: readonly SitePermission[]): 'camera' | 'microphone' | 'location' | null {
  for (const p of perms) if (p === 'camera' || p === 'microphone' || p === 'location') return p
  return null
}

/** What macOS turned off, as noun keys to join ("camera and microphone", "location"). */
export function macosNouns(perms: readonly SitePermission[]): MessageKey[] {
  const out: MessageKey[] = []
  const media = mediaNoun(perms.includes('camera'), perms.includes('microphone'))
  if (media) out.push(media)
  if (perms.includes('location')) out.push('sites.noun.location')
  return out
}
