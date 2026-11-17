/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { browserSmoke, type SmokeGroup, type SmokeContext } from './smokeBrowser'
import { captureWindow } from './smokeKit'
import { settleOverlays, withOverlaysClosed } from './smokeShots'
import { voicePasswordsSmoke } from './smokeVoicePasswords'
import { filesConnectorsSmoke } from './smokeFilesConnectors'
import { agentWorkspaceSmoke } from './smokeAgentWorkspace'
import { maintenanceSmoke } from './smokeMaintenance'
// ── layout audit ── (APEX_SMOKE_ONLY=layout)
import { layoutSmoke } from './smokeLayout'
// ── tweaks smoke group ── (APEX_SMOKE_ONLY=tweaks)
import { tweaksSmoke } from './tweaks/smoke'
// ── media hub smoke group ── (APEX_SMOKE_ONLY=media)
import { mediaSmoke } from './smokeMedia'
// ── privacy pack smoke group ── (APEX_SMOKE_ONLY=privacy)
import { privacySmoke } from './privacy/smoke'
// ── translate smoke group ── (APEX_SMOKE_ONLY=translate)
import { translateSmoke } from './translate/smoke'
// ── reader smoke group ── (APEX_SMOKE_ONLY=reader)
import { readerSmoke } from './reader/smoke'
// ── packs smoke group ── (APEX_SMOKE_ONLY=packs)
import { packsSmoke } from './packs/smoke'
// ── quick decisions smoke group ── (APEX_SMOKE_ONLY=decisions)
import { decisionsSmoke } from './decisions/smoke'

// Runs the smoke groups after the base checks, in this order.
// APEX_SMOKE_ONLY=BROWSER,MAINTENANCE (any case) limits the run to those groups;
// shots run only with APEX_SMOKE_SHOTS.

export const SMOKE_GROUPS: SmokeGroup[] = [
  browserSmoke,
  voicePasswordsSmoke,
  filesConnectorsSmoke,
  agentWorkspaceSmoke,
  maintenanceSmoke,
  // ── tweaks smoke group ──
  tweaksSmoke,
  // ── media hub smoke group ──
  mediaSmoke,
  // ── privacy pack smoke group ──
  privacySmoke,
  // ── translate smoke group ──
  translateSmoke,
  // ── reader smoke group ──
  readerSmoke,
  // ── packs smoke group ──
  packsSmoke,
  // ── quick decisions smoke group ──
  decisionsSmoke,
  // ── layout audit ── (last: it resizes the window through every width)
  layoutSmoke,
]

/** The groups APEX_SMOKE_ONLY selects (all of them when unset). */
export function selectedGroups(only: string | undefined, groups: readonly SmokeGroup[] = SMOKE_GROUPS): SmokeGroup[] {
  const wanted = (only ?? '')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean)
  return wanted.length === 0 ? [...groups] : groups.filter((g) => wanted.includes(g.group))
}

/** shot() for a context: <dir>/<name>-<theme>.png, or nothing without a shots folder. */
export function shotWriter(dir: string | undefined, theme: string, capture: () => Promise<Buffer>): (name: string) => Promise<void> {
  if (!dir) return async () => undefined
  mkdirSync(dir, { recursive: true })
  return async (name) => {
    writeFileSync(join(dir, `${name}-${theme}.png`), await capture())
  }
}

export async function runSmokeGroups(
  base: Omit<SmokeContext, 'shot'>,
  check: (name: string, fn: () => Promise<string>) => Promise<unknown>,
): Promise<void> {
  const dir = process.env.APEX_SMOKE_SHOTS
  const theme = process.env.APEX_SMOKE_THEME === 'dark' ? 'dark' : 'light'
  // A shot waits for its overlay surfaces to draw, and closes what it opened afterwards.
  const capture = async (): Promise<Buffer> => {
    await settleOverlays()
    return (await captureWindow(base.chrome.ui, base.tabs)).toPNG()
  }
  const ctx: SmokeContext = { ...base, shot: shotWriter(dir, theme, capture) }
  // APEX_SMOKE_SKIP=<regex> leaves out matching checks, for narrowing down a failure.
  const skip = process.env.APEX_SMOKE_SKIP ? new RegExp(process.env.APEX_SMOKE_SKIP) : null
  for (const group of selectedGroups(process.env.APEX_SMOKE_ONLY)) {
    for (const c of group.checks) if (!skip?.test(c.name)) await check(`${group.group}: ${c.name}`, async () => (await c.run(ctx), ''))
    if (dir) for (const s of group.shots) await check(`${group.group} shot: ${s.name}`, async () => (await withOverlaysClosed(() => s.run(ctx)), ''))
  }
}
