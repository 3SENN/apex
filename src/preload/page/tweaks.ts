/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { ipcRenderer, webFrame } from 'electron'
import { TWEAK_WORLD_ID, type PageTweakMessage, type PageTweakPush, type PageTweakRules } from '@shared/tweaks'
import { PAGE } from '@shared/ipc'
import { startPicker, type Picker } from './picker'

// Tweaks in the page (TWK-01): the top frame of a web page asks main for its
// rules before any page script runs. The generated rules (hidden elements and
// style) and custom CSS go in with webFrame.insertCSS, which the page's CSP
// doesn't govern and page scripts can't see or remove. Both are author styles:
// Electron removes only author sheets again (removeInsertedCSS), and a tweak
// changes live; the hiding rules carry their own weight instead
// (shared/tweaks.ts hiddenCss). Scripts run in an isolated
// world of their own (TWEAK_WORLD_ID): the page's DOM, none of its JavaScript
// and none of this preload's. page.ts installs this only off sign-in pages;
// main answers nothing there or on apex:// pages anyway.

export function installTweaks(): void {
  if (!/^https?:$/.test(location.protocol)) return
  const send = (message: PageTweakMessage): void => ipcRenderer.send(PAGE.tweaks, message)
  let rules: PageTweakRules | null = null
  try {
    rules = ipcRenderer.sendSync(PAGE.tweaks, { kind: 'get', url: location.href } satisfies PageTweakMessage) as PageTweakRules | null
  } catch {
    // Main didn't answer (a page outside a tab): the page stays as the site made it.
  }

  let keys: string[] = []
  const apply = (next: PageTweakRules | null): void => {
    for (const key of keys) {
      try {
        webFrame.removeInsertedCSS(key)
      } catch {
        // Already gone with its document.
      }
    }
    keys = []
    if (next?.generated) keys.push(webFrame.insertCSS(next.generated, { cssOrigin: 'author' }))
    if (next?.custom) keys.push(webFrame.insertCSS(next.custom, { cssOrigin: 'author' }))
  }
  apply(rules)

  if (rules && rules.scripts.length > 0) {
    try {
      webFrame.setIsolatedWorldInfo(TWEAK_WORLD_ID, { name: `${BRAND_NAME} tweak` })
      void webFrame.executeJavaScriptInIsolatedWorld(TWEAK_WORLD_ID, rules.scripts.map((code) => ({ code }))).catch((err: unknown) => console.error(`${BRAND_NAME} tweak script failed`, err))
    } catch (err) {
      console.error(`${BRAND_NAME} tweak script failed`, err)
    }
  }

  let picker: Picker | null = null
  ipcRenderer.on(PAGE.tweaksPush, (_event, push: PageTweakPush) => {
    if (!push || typeof push !== 'object') return
    if (push.kind === 'rules') apply(push.rules)
    else if (push.kind === 'pick') {
      if (push.on) picker ??= startPicker(push.strings, { send, onEnd: () => (picker = null) })
      else picker?.stop()
    } else if (push.kind === 'count') picker?.update(push.count, push.announce)
  })
}
