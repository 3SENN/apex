/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TRANSLATE_DEFAULTS, type TabTranslate } from '@shared/translate'
import { assert, docWith, waitFor, type Chrome } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { SmokeGroup, ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { translateSmokeHooks, type TranslateSmokeHooks } from './feature'

// Page translation's smoke checks (ATELIER_SMOKE_ONLY=translate), on a local
// French fixture page with the fake engine (feature.ts swaps it in under
// smoke, so no helper and no model ever runs): the offer in the pill, the
// popover's Translate, text and attributes changed in place while code,
// inputs and translate="no" stay, content the page adds afterwards, Show
// original restoring the page exactly, Never translate this site, and the
// not-downloaded error.

const PATH = '/translate/fr'

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Page en français</title></head>
<body style="font:16px system-ui;padding:40px">
<h1 id="h">Bonjour le monde</h1>
<p id="p">Bienvenue sur notre site <a id="a" href="#suite">Lire la suite</a></p>
<img id="img" alt="Une image de la ville" width="1" height="1" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<input id="in" placeholder="Votre adresse e-mail" value="moi@exemple.fr">
<pre id="pre">const bonjour = "le monde"</pre>
<p id="no" translate="no">Le Monde Diplomatique</p>
<p id="long">Les habitants de la ville se retrouvent chaque samedi sur la place du marché pour acheter des fruits, des légumes et du pain frais. Les enfants jouent pendant que les parents discutent avec les voisins de la semaine.</p>
</body></html>`

const DYNAMIC = '<p id="dyn">Nouveau contenu ajouté</p>'

function hooks(): TranslateSmokeHooks {
  const h = translateSmokeHooks()
  assert(h, 'the translate feature runs with its smoke fakes')
  return h
}

async function frenchTab(ctx: SmokeContext): Promise<Tab> {
  ctx.server.page(PATH, PAGE)
  const tab = ctx.tabs.create(`${ctx.server.http}${PATH}`, { activate: true })
  await waitForPage(tab.view.webContents, 'the French fixture page', 8000, (at) => at.includes(PATH))
  return tab
}

const state = (tab: Tab): TabTranslate | null => hooks().controller.info(tab.id)

async function waitStatus(tab: Tab, status: TabTranslate['status'] | null, what: string): Promise<void> {
  await waitFor(() => (state(tab)?.status ?? null) === status, 8000, what)
}

function page<T>(tab: Tab, script: string): Promise<T> {
  return tab.view.webContents.executeJavaScript(script) as Promise<T>
}

const SNAPSHOT = `({ title: document.title, body: document.body.innerHTML })`

/** The popover, opened from the pill when it is not open (a window that loses focus closes menus). */
async function popover(ctx: SmokeContext): Promise<Chrome> {
  const open = await ctx.chrome.js<boolean>(`return document.querySelector('.pill__translate')?.getAttribute('aria-expanded') === 'true'`)
  if (!open) await ctx.chrome.js(`document.querySelector('.pill__translate').click()`)
  return docWith(ctx.chrome, '.trp', 5000, 'the translate popover', { overlayOnly: true })
}

/** Presses a popover button, reopening the popover once if it closed meanwhile. */
async function press(ctx: SmokeContext, label: RegExp): Promise<void> {
  try {
    await (await popover(ctx)).click(label, `document.querySelector('.trp')`, 2500)
  } catch {
    await (await popover(ctx)).click(label, `document.querySelector('.trp')`)
  }
}

const translatePage: SmokeCheck = {
  name: 'translate: a French page is offered, translated in place, follows new content and restores exactly',
  async run(ctx) {
    const h = hooks()
    h.setAppleStatus('installed')
    ctx.settings.update({ translate: TRANSLATE_DEFAULTS })
    const tab = await frenchTab(ctx)
    try {
      await waitStatus(tab, 'offer', 'the translate offer on a French page')
      assert(state(tab)?.language.startsWith('fr'), `the page reads as French (got ${state(tab)?.language})`)
      assert(ctx.tabs.info(tab).translate?.status === 'offer', 'TabInfo carries the offer to the chrome')
      await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('.pill__translate'))`, 5000, 'the translate button in the pill')
      const before = await page<{ title: string; body: string }>(tab, SNAPSHOT)

      // The popover's Translate, as a person would press it.
      await press(ctx, /^Translate$/)
      await waitStatus(tab, 'translated', 'the page to be translated')

      const after = await page<Record<string, string | null>>(
        tab,
        `({ title: document.title, h: document.getElementById('h').textContent, a: document.getElementById('a').textContent,
            alt: document.getElementById('img').getAttribute('alt'), ph: document.getElementById('in').getAttribute('placeholder'),
            value: document.getElementById('in').value, pre: document.getElementById('pre').textContent, no: document.getElementById('no').textContent,
            href: document.getElementById('a').getAttribute('href'), long: document.getElementById('long').textContent })`,
      )
      assert(after.title === 'Page in French', `the title is translated (got ${after.title})`)
      assert(after.h === 'Hello world', `the heading is translated (got ${after.h})`)
      assert(after.a === 'Read more' && after.href === '#suite', 'the link text is translated, its address kept')
      assert(after.alt === 'A picture of the city', `alt is translated (got ${after.alt})`)
      assert(after.ph === 'Your email address' && after.value === 'moi@exemple.fr', 'the placeholder is translated, the value kept')
      assert(after.pre === 'const bonjour = "le monde"', 'code is left alone')
      assert(after.no === 'Le Monde Diplomatique', 'translate="no" is left alone')
      assert(/^\[[A-Za-z-]+\] /.test(after.long ?? ''), `the rest goes through the engine (got ${after.long?.slice(0, 40)})`)
      const sent = h.calls().flat()
      assert(!sent.some((t) => t.includes('const bonjour') || t.includes('Diplomatique') || t.includes('moi@exemple')), 'skipped text never reaches the engine')

      // Content the page adds while translated is translated too.
      await page(tab, `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(DYNAMIC)})`)
      await waitFor(async () => (await page<string>(tab, `document.getElementById('dyn')?.textContent ?? ''`)) === 'New content added', 5000, 'new content to be translated')

      // Show original: the page exactly as it was, the new paragraph back in French.
      await press(ctx, /^Show original$/)
      await waitStatus(tab, 'offer', 'the offer after Show original')
      await waitFor(async () => (await page<{ body: string }>(tab, SNAPSHOT)).body === before.body + DYNAMIC, 5000, 'the original page back')
      const restored = await page<{ title: string; body: string }>(tab, SNAPSHOT)
      assert(restored.title === before.title, 'the title is restored')
      await (await popover(ctx)).escape()
    } finally {
      if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
      ctx.settings.update({ translate: TRANSLATE_DEFAULTS })
    }
  },
}

const neverAndErrors: SmokeCheck = {
  name: 'translate: never this site hides the offer, and languages that are not downloaded say so',
  async run(ctx) {
    const h = hooks()
    ctx.settings.update({ translate: TRANSLATE_DEFAULTS })
    const tab = await frenchTab(ctx)
    try {
      await waitStatus(tab, 'offer', 'the translate offer')
      await ctx.chrome.invoke('translate', 'setNeverSite', tab.id, true)
      await waitStatus(tab, null, 'no offer on a never-translated site')
      assert(ctx.settings.get().translate.neverSites.includes(new URL(ctx.server.http).hostname), 'the site is on the never list')
      await ctx.chrome.until<boolean>(`return !document.querySelector('.pill__translate')`, 5000, 'the translate button gone')
      await ctx.chrome.invoke('translate', 'setNeverSite', tab.id, false)
      await waitStatus(tab, 'offer', 'the offer back')

      h.setAppleStatus('supported')
      await ctx.chrome.invoke('translate', 'translate', tab.id)
      await waitStatus(tab, 'error', 'the not-downloaded error')
      assert(state(tab)?.error === 'not-installed', `the error says the languages are missing (got ${state(tab)?.error})`)
      assert((await page<string>(tab, `document.getElementById('h').textContent`)) === 'Bonjour le monde', 'nothing changed on the page')

      // The companion takes over only when it is turned on.
      ctx.settings.update({ translate: { ...TRANSLATE_DEFAULTS, companion: true } })
      await ctx.chrome.invoke('translate', 'translate', tab.id)
      await waitStatus(tab, 'translated', 'the companion engine to translate')
      assert(state(tab)?.engine === 'companion', 'the companion engine translated it')
    } finally {
      h.setAppleStatus('installed')
      if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
      ctx.settings.update({ translate: TRANSLATE_DEFAULTS })
    }
  },
}

const popoverShot: ShotSpec = {
  name: 'translate-popover',
  async run(ctx) {
    ctx.settings.update({ translate: TRANSLATE_DEFAULTS })
    const tab = await frenchTab(ctx)
    try {
      await waitStatus(tab, 'offer', 'the translate offer')
      await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('.pill__translate'))`, 5000, 'the translate button')
      await ctx.chrome.js(`document.querySelector('.pill__translate').click()`)
      const pop = await docWith(ctx.chrome, '.trp', 5000, 'the translate popover', { overlayOnly: true })
      await ctx.shot('translate-popover')
      await pop.escape()
    } finally {
      if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
    }
  },
}

export const translateSmoke: SmokeGroup = { group: 'TRANSLATE', checks: [translatePage, neverAndErrors], shots: [popoverShot] }
