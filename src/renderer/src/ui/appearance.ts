/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { SettingsView } from '@shared/ipc'
import { interfaceTokens, type InterfaceSettings } from './logic/appearance'

// Interface density, text size, sidebar tint and chat zoom (ST-26, ST-27)
// as attributes and variables on <html>, before the first render and live
// after every settings change. styles.css turns them into tokens. The UI typeface check runs once the fonts are ready.

let applied = ''

export function applyInterfaceSettings(settings: InterfaceSettings): void {
  if (typeof document === 'undefined') return
  const tokens = interfaceTokens(settings)
  const key = JSON.stringify(tokens)
  if (key === applied) return
  applied = key
  const root = document.documentElement
  for (const [name, value] of Object.entries(tokens.attributes)) root.dataset[name] = value
  for (const [name, value] of Object.entries(tokens.variables)) root.style.setProperty(name, value)
}

/** Inter is bundled (@fontsource-variable/inter); if it didn't load, say so once and mark the fallback. */
export async function checkInterfaceFont(doc: Document = document): Promise<boolean> {
  try {
    await doc.fonts.ready
    await doc.fonts.load('13px "Inter Variable"')
    const ok = doc.fonts.check('13px "Inter Variable"')
    if (!ok) {
      doc.documentElement.dataset.uiFont = 'fallback'
      console.warn(`The Inter typeface did not load; ${BRAND_NAME} is using the system font.`)
    }
    return ok
  } catch {
    return false
  }
}

if (typeof window !== 'undefined' && window.atelier?.initial?.settings) {
  applyInterfaceSettings(window.atelier.initial.settings)
  window.atelier.onAppEvent((event) => {
    if (event.type === 'settings') applyInterfaceSettings(event.view as SettingsView)
  })
  void checkInterfaceFont()
}
