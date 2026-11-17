/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { Menu } from 'electron'
import { EN } from '@shared/i18n/en'
import { currentLanguage, pseudoActive } from '@shared/i18n/core'
import { PSEUDO_FLAG } from '@shared/i18n/apply'
import { assert, sleep, waitFor } from '../smokeKit'
import { mainT } from '../i18n/mainT'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'
import type { SmokeContext } from '../smokeBrowser/types'

// Switching to Dutch relabels the Settings nav, the Languages page
// and the native menus live, and switching back restores them; the en-XA run
// shows no raw catalogue keys (the sidebar destinations aren't checked
// here). Offline only; nothing relaunches.

const SETTINGS_TITLE = '.sp-nav__title'

function topMenuLabels(): string[] {
  return Menu.getApplicationMenu()?.items.map((item) => item.label) ?? []
}

async function openLanguages(ctx: SmokeContext): Promise<void> {
  ctx.tabs.openInternal('apex://settings/languages')
  await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('[data-settings-anchor="app-language"] select'))`, 8000, 'the Languages page’s app-language select')
  // An earlier check may have left the nav folded to its rail, which has no title; open it.
  await ctx.chrome.js(`document.querySelector('.sp-nav--rail .sp-nav__head button')?.click(); return true`)
  await ctx.chrome.until<boolean>(`return Boolean(document.querySelector(${JSON.stringify(SETTINGS_TITLE)}))`, 3000, 'the Settings nav title')
}

async function setLanguage(ctx: SmokeContext, appLanguage: 'en' | 'nl' | 'system', expectNav: string): Promise<void> {
  ctx.settings.update({ appLanguage })
  await ctx.chrome.until<boolean>(`return document.querySelector(${JSON.stringify(SETTINGS_TITLE)})?.textContent === ${JSON.stringify(expectNav)}`, 5000, `the Settings nav to read “${expectNav}”`)
}

async function setPseudo(ctx: SmokeContext, on: boolean): Promise<void> {
  const flags = { ...(ctx.settings.get().flags ?? {}) }
  if (on) flags[PSEUDO_FLAG] = 'on'
  else delete flags[PSEUDO_FLAG]
  ctx.settings.update({ flags })
  await waitFor(() => pseudoActive() === on, 3000, `the pseudo-locale to turn ${on ? 'on' : 'off'}`)
  await ctx.chrome.until<boolean>(`return (document.documentElement.lang === 'en-XA') === ${on}`, 5000, 'the chrome to follow the pseudo-locale')
}

/** Visible text in the chrome that is exactly a catalogue key: a string that missed its lookup. */
async function rawKeysShown(ctx: SmokeContext): Promise<string[]> {
  const keys = Object.keys(EN)
  // Chrome.js runs a function body, so the result has to be returned.
  return ctx.chrome.js<string[]>(`return (() => {
    const keys = new Set(${JSON.stringify(keys)})
    const found = new Set()
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const text = (walker.currentNode.textContent || '').trim()
      if (keys.has(text)) found.add(text)
    }
    for (const el of document.querySelectorAll('[aria-label],[title],[placeholder]')) {
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        const v = el.getAttribute(attr)
        if (v && keys.has(v.trim())) found.add(v.trim())
      }
    }
    return [...found].slice(0, 20)
  })()`)
}

export const checks: SmokeCheck[] = [
  {
    name: 'i18n: Dutch relabels the Settings nav, the Languages page and the native menus live; English restores them',
    async run(ctx) {
      const before = ctx.settings.get().appLanguage
      await openLanguages(ctx)
      try {
        await setLanguage(ctx, 'nl', 'Instellingen')
        assert(currentLanguage() === 'nl', `main speaks ${currentLanguage()}, not nl`)
        assert(mainT('menus.top.file') === 'Archief', 'mainT still returns English')
        await ctx.chrome.until<boolean>(`return document.querySelector('[data-settings-anchor="app-language"]')?.closest('section')?.textContent?.includes(${JSON.stringify(`Taal van ${BRAND_NAME}`)}) === true`, 5000, 'the app-language card in Dutch')
        await ctx.chrome.until<boolean>(`return document.documentElement.lang.startsWith('nl')`, 3000, 'html lang to follow Dutch')
        if (process.platform === 'darwin') await waitFor(() => topMenuLabels().includes('Archief'), 3000, 'the native File menu to read Archief')
        await setLanguage(ctx, 'en', 'Settings')
        assert(mainT('menus.top.file') === 'File', 'mainT did not return to English')
        if (process.platform === 'darwin') await waitFor(() => topMenuLabels().includes('File'), 3000, 'the native File menu to read File again')
      } finally {
        ctx.settings.update({ appLanguage: before })
      }
    },
  },
  {
    name: 'i18n: the pseudo-locale brackets main and the chrome, and shows no raw catalogue keys',
    async run(ctx) {
      await openLanguages(ctx)
      try {
        await setPseudo(ctx, true)
        const label = mainT('menus.top.file')
        assert(label.startsWith('[') && label.endsWith(']') && label.length > 'File'.length, `mainT returned “${label}” under en-XA`)
        await ctx.chrome.until<boolean>(`return (document.querySelector(${JSON.stringify(SETTINGS_TITLE)})?.textContent || '').startsWith('[')`, 5000, 'the Settings nav in en-XA')
        const raw = await rawKeysShown(ctx)
        assert(raw.length === 0, `raw catalogue keys on screen: ${raw.join(', ')}`)
      } finally {
        await setPseudo(ctx, false)
      }
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'Languages page in Dutch',
    async run(ctx) {
      const before = ctx.settings.get().appLanguage
      await openLanguages(ctx)
      try {
        await setLanguage(ctx, 'nl', 'Instellingen')
        await sleep(300)
        await ctx.shot('languages-nl')
      } finally {
        await setLanguage(ctx, before === 'nl' ? 'en' : before, 'Settings')
      }
    },
  },
  {
    name: 'Settings and the shell in the pseudo-locale',
    async run(ctx) {
      await openLanguages(ctx)
      try {
        await setPseudo(ctx, true)
        await sleep(300)
        await ctx.shot('languages-pseudo-settings')
        ctx.tabs.openInternal('apex://settings/general')
        await sleep(600)
        await ctx.shot('languages-pseudo-general')
      } finally {
        await setPseudo(ctx, false)
      }
    },
  },
]
