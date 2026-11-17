/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TWEAK_EXPORT_FORMAT, TWEAK_EXPORT_VERSION, TWEAK_LIMITS, type Tweak } from '@shared/tweaks'
import { mainT } from '../i18n/mainT'
import { tweakExportSchema, type ImportedTweak } from './schemas'
import { TweakError } from './store'

// Export and import (TWK-06): a JSON file anyone can read. What it carries is
// the site, its hidden elements, style, CSS and script; never the script switch, so an
// imported script stays off until its new owner has read it and turned it on.

export interface TweakExportFile {
  format: typeof TWEAK_EXPORT_FORMAT
  version: number
  exportedAt: string
  tweaks: Array<Pick<Tweak, 'host' | 'subdomains' | 'enabled' | 'style' | 'css' | 'js'> & { hidden: Array<{ selector: string; label: string }> }>
}

export function exportTweaks(tweaks: readonly Tweak[], now = new Date()): string {
  const file: TweakExportFile = {
    format: TWEAK_EXPORT_FORMAT,
    version: TWEAK_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    tweaks: tweaks.map((b) => ({ host: b.host, subdomains: b.subdomains, enabled: b.enabled, hidden: b.hidden.map((el) => ({ selector: el.selector, label: el.label })), style: { ...b.style }, css: b.css, js: b.js })),
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

/** The tweaks in an exported file; throws a TweakError worded for the person when it isn't one. */
export function parseTweakExport(text: string): ImportedTweak[] {
  if (text.length > TWEAK_LIMITS.importBytes) throw new TweakError(mainT('tweaks.error.tooBig'))
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    throw new TweakError(mainT('tweaks.error.notTweaks'))
  }
  const parsed = tweakExportSchema.safeParse(json)
  if (!parsed.success) throw new TweakError(mainT('tweaks.error.notTweaks'))
  // Ids and the script switch never come from a file.
  return parsed.data.tweaks.map(({ id: _id, jsEnabled: _js, ...rest }) => ({ ...rest, hidden: rest.hidden.map(({ id: _el, ...el }) => el) }))
}

/** The file name an export suggests: one site's name, or all of them. */
export function exportName(tweaks: readonly Pick<Tweak, 'host'>[]): string {
  const only = tweaks.length === 1 ? tweaks[0]?.host.replace(/[^a-z0-9.-]/gi, '-') : null
  return only ? `${only}.apex-tweak.json` : 'apex-tweaks.json'
}
