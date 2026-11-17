/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installStorageSync } from '@shared/extensionStorageSync'

// The content-script prelude. Atelier's preloads reach an extension's
// worker and pages, but not its content scripts, which run in a world of
// their own. For Web Store installs (Atelier's own copy of the package) Atelier
// adds one small script ahead of each content_scripts entry's own files,
// so content scripts get the same chrome.storage.sync as the rest of the
// extension. A developer's unpacked folder is never written to.

/** Not under "_": Chromium refuses extension files whose names start with an underscore. */
export const CONTENT_COMPAT_FILE = 'atelier-compat/content.js'

export function contentCompatSource(): string {
  return `// Added by ${BRAND_NAME}: chrome.storage.sync for content scripts (see ${BRAND_NAME}'s extension notes).\n;(${installStorageSync.toString()})();\n`
}

/**
 * Writes the prelude and puts it first in every content_scripts entry with
 * scripts. Idempotent; returns whether the manifest changed.
 */
export function applyContentCompat(dir: string): boolean {
  const file = join(dir, 'manifest.json')
  if (!existsSync(file)) return false
  const manifest = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as { content_scripts?: Array<{ js?: unknown }> }
  const entries = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  const target = join(dir, CONTENT_COMPAT_FILE)
  const source = contentCompatSource()
  if (entries.some((e) => Array.isArray(e.js) && e.js.length > 0)) {
    mkdirSync(join(dir, 'atelier-compat'), { recursive: true })
    if (!existsSync(target) || readFileSync(target, 'utf8') !== source) writeFileSync(target, source)
  }
  let changed = false
  for (const entry of entries) {
    if (!Array.isArray(entry.js) || entry.js.length === 0) continue
    const js = entry.js.filter((p): p is string => typeof p === 'string')
    if (js[0] === CONTENT_COMPAT_FILE) continue
    entry.js = [CONTENT_COMPAT_FILE, ...js.filter((p) => p !== CONTENT_COMPAT_FILE)]
    changed = true
  }
  if (changed) writeFileSync(file, JSON.stringify(manifest, null, 2))
  return changed
}
