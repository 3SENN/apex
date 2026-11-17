/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { native as nativeStrings } from '@shared/i18n/en/native'
import { SETTINGS_INDEX, settingsRowUrl } from '@shared/settingsIndex'

// The lid-pause row (Transcription) and the haptics row (General) are
// reachable from settings search, by the anchors their rows declare.

const NATIVE = join(__dirname, '..', 'src', 'renderer', 'src', 'native')
const PAGES = join(__dirname, '..', 'src', 'renderer', 'src', 'settings', 'pages')

/** The value of `export const <name> = '<anchor>'` in a row's source. */
function anchorConst(file: string, name: string): string {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(readFileSync(join(NATIVE, file), 'utf8'))
  if (!match?.[1]) throw new Error(`${name} not found in ${file}`)
  return match[1]
}

describe('settings search: native rows', () => {
  const rows = [
    { anchor: anchorConst('LidPauseRow.tsx', 'LID_PAUSE_ANCHOR'), page: 'transcription', mount: 'TranscriptionPage.tsx', row: 'LidPauseRow', word: 'lid' },
    { anchor: anchorConst('HapticsRow.tsx', 'HAPTICS_ANCHOR'), page: 'general', mount: 'GeneralPage.tsx', row: 'HapticsRow', word: 'haptic' },
  ]

  for (const r of rows) {
    it(`indexes ${r.anchor} on the page that mounts it`, () => {
      expect(readFileSync(join(PAGES, r.mount), 'utf8')).toContain(`<${r.row}`)
      const entry = SETTINGS_INDEX.find((e) => e.anchor === r.anchor)
      expect(entry?.page).toBe(r.page)
      expect(Object.hasOwn(nativeStrings, entry?.title ?? '')).toBe(true)
      expect(entry?.keywords.some((k) => k.includes(r.word))).toBe(true)
      expect(settingsRowUrl(entry!)).toBe(`atelier://settings/${r.page}?highlight=${r.anchor}`)
    })
  }
})
