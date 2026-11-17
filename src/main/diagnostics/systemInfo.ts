/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { release } from 'node:os'
import { app } from 'electron'
import { RELEASE } from '@shared/release'

// System details (SH-58 copy diagnostics, the report's report.json,
// the feedback draft's system line). One builder, shared with the Help menu's
// Copy Diagnostics item. Versions and platform only: never names, paths, keys or
// tokens. The pure part takes its inputs so tests need no Electron.

export interface SystemInfoInput {
  version: string
  channel: string
  platform: NodeJS.Platform
  osVersion: string
  arch: string
  electron: string
  chrome: string
  node: string
  locale: string
  engine: string
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

/** Ordered key/value pairs; the keys are stable (report.json and the copy-diagnostics text use them). */
export function systemInfoFrom(input: SystemInfoInput): Record<string, string> {
  return {
    app: `${BRAND_NAME} ${input.version}`,
    channel: input.channel,
    os: `${OS_NAMES[input.platform] ?? input.platform} ${input.osVersion}`.trim(),
    arch: input.arch,
    electron: input.electron,
    chrome: input.chrome,
    node: input.node,
    locale: input.locale,
    engine: input.engine,
  }
}

/** "Atelier 0.1.0 (dev) · macOS 26.1 · arm64 · Electron 45.1.0 · Chromium 142…", for emails and the clipboard. */
export function systemLine(info: Record<string, string>): string {
  const parts = [`${info.app ?? BRAND_NAME}${info.channel ? ` (${info.channel})` : ''}`, info.os, info.arch, info.electron && `Electron ${info.electron}`, info.chrome && `Chromium ${info.chrome}`]
  return parts.filter(Boolean).join(' · ')
}

/** The same details as text, one per line (Help › Copy Diagnostics). */
export function systemInfoText(info: Record<string, string>): string {
  return Object.entries(info)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function osVersion(): string {
  try {
    // getSystemVersion gives the marketing version on macOS (26.1), not the Darwin release.
    return process.getSystemVersion?.() || release()
  } catch {
    return release()
  }
}

/** This run's details. `engine` is the engine kind (an EngineId such as 'api-key'), never a key. */
export function collectSystemInfo(engine: string): Record<string, string> {
  return systemInfoFrom({
    version: app.getVersion(),
    channel: RELEASE.channel,
    platform: process.platform,
    osVersion: osVersion(),
    arch: process.arch,
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    locale: app.getLocale(),
    engine,
  })
}
