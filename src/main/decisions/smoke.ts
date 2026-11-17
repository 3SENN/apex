/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { DECISIONS_DEFAULTS, DECISION_PRESETS, type DecisionCatalog, type DecisionResult, type DecisionsStatus, type DecisionTestResult } from '@shared/decisions'
import { SMOKE_SERVER } from './smokeServer'
import { assert, docWith, sleep, waitFor, type Chrome } from '../smokeKit'
import type { SmokeGroup, ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { clientTool } from '../agent/tools/registry'
import { nothingToRemember } from '../memoryJobs'
import { addressSmoke } from '../features/address'
import { waitForPage } from '../smokeLoad'
import { decider, setDecider, type DecideCall, type Decider } from './service'
import { needsYou } from './uses'
import { groupTabsCheck } from './smokeTabs'
import { effortPerMessageCheck } from './smokeSetup'

// Quick decisions' smoke checks (ATELIER_SMOKE_ONLY=decisions). Smoke's
// stand-in model (feature.ts) answers instead of a provider, sure of every
// first option, so nothing reaches the network: off keeps the rules, a
// custom server set up turns the decider on and offers its decision models,
// the settings section shows its cards, every provider, the model chips and
// its test line, compare mode keeps the rule and notes the difference, and
// Settings › Your data lists the comparisons.

const OWN_SERVER = SMOKE_SERVER

async function openSettingsPage(ctx: SmokeContext, page: 'decisions' | 'model'): Promise<void> {
  ctx.tabs.openInternal(`atelier://settings/${page}`)
  await waitFor(() => ctx.tabs.snapshot().tabs.some((t) => t.url.startsWith(`atelier://settings/${page}`)), 5000, `Settings › ${page}`)
  await sleep(400)
}
const openModelPage = (ctx: SmokeContext): Promise<void> => openSettingsPage(ctx, 'decisions')

const offKeepsRules: SmokeCheck = {
  name: 'decisions: off keeps Atelier’s rules and asks nothing',
  async run(ctx) {
    ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    const status = await ctx.chrome.invoke<DecisionsStatus>('decisions', 'status')
    assert(!status.on && !status.ready && status.models.length === 0, `off by default (got ${JSON.stringify(status)})`)
    assert(!decider().active('needsYou'), 'no use is active while off')
    assert((await needsYou('Done. Want me to do anything else?', true, false)) === true, 'the closing-“?” rule decides')
    assert((await ctx.chrome.invoke<string>('decisions', 'searchOrAsk', 'pizza near me', 'ask')) === 'ask', 'the composer’s mode decides')
  },
}

const ownServer: SmokeCheck = {
  name: 'decisions: your own server answers, the test line works, compare mode only notes',
  async run(ctx) {
    try {
      ctx.settings.update({ decisions: OWN_SERVER })
      const status = await ctx.chrome.invoke<DecisionsStatus>('decisions', 'status')
      assert(status.ready && status.connected['server-1'] === true, 'ready with a server of yours')
      const test = await ctx.chrome.invoke<DecisionTestResult>('decisions', 'test')
      assert(test.ok && test.answered === 'kev-latest', `the test reaches the stand-in (got ${JSON.stringify(test)})`)
      // DC-13: the companion's label_items is registered and offered while the model is on, and labels through it.
      const tool = clientTool('label_items')
      assert(tool, 'label_items is registered')
      assert(
        tool.enabled({
          companionId: 'pip',
          browser: true,
          memory: true,
          routine: false,
          private: false,
          flags: {},
          workspace: {
            folders: false,
            tables: false,
            apps: false,
            calendar: false,
            activity: false,
          },
        }),
        'label_items is offered to a new chat',
      )
      const labeled = await tool.run(
        {
          items: [
            { id: 'a', text: 'Your order has shipped.' },
            { id: 'b', text: 'Dinner tonight?' },
          ],
          questions: {
            topic: {
              type: 'choice',
              instructions: 'What is it about?',
              criteria: { shopping: null, personal: null },
            },
          },
        },
        {
          chatId: 'smoke',
          companionId: 'pip',
          isPrivate: false,
          isRoutine: false,
          signal: new AbortController().signal,
          emit: () => undefined,
          ask: () => Promise.reject(new Error('no')),
        },
      )
      assert(!labeled.isError && /"id":"a","answers":\{"topic":\{"answer":"shopping"/.test(labeled.content), `label_items answers through the model (got ${labeled.content.slice(0, 200)})`)
      const catalog = await ctx.chrome.invoke<DecisionCatalog[]>('decisions', 'catalog')
      assert(
        JSON.stringify(catalog.map((c) => [c.provider, c.models.map((m) => m.id)])) === JSON.stringify([['server-1', ['kev-0.8b', 'kev-latest']]]),
        `the server's decision models are offered, its chat models left out (got ${JSON.stringify(catalog)})`,
      )
      // The stand-in is sure of the first option, so a search-or-ask answer is "search".
      assert((await ctx.chrome.invoke<string>('decisions', 'searchOrAsk', 'pizza near me', 'ask')) === 'search', 'a sure answer wins in use mode')
      assert((await ctx.chrome.invoke<string>('decisions', 'searchOrAsk', 'https://example.com', 'ask')) === 'ask', 'an address never asks the model')
      assert((await needsYou('Tell me which one you’d like.', false, false)) === true, 'the stand-in’s sure yes corrects the rule')
      assert((await needsYou('Tell me which one you’d like.', false, true)) === false, 'a private chat keeps the rule')

      await ctx.chrome.invoke('decisions', 'clearComparisons')
      ctx.settings.update({ decisions: { ...OWN_SERVER, mode: 'compare' } })
      assert((await needsYou('All done.', false, false)) === false, 'compare mode answers with the rule')
      await waitFor(async () => (await ctx.chrome.invoke<unknown[]>('decisions', 'comparisons')).length > 0, 5000, 'the difference noted')

      await openModelPage(ctx)
      await ctx.chrome.until<boolean>(`return [...document.querySelectorAll('.dc-comparison')].length > 0`, 5000, 'the comparisons list in Settings')
      const providers = await ctx.chrome.js<number>(`return document.querySelectorAll('[data-settings-anchor^="decisions-provider-"]').length`)
      assert(providers === DECISION_PRESETS.length, `every listed provider is offered (got ${providers})`)
      await ctx.chrome.until<boolean>(`return /kev-latest/.test(document.querySelector('.dc-models')?.textContent ?? '') && /First choice/.test(document.querySelector('.dc-models')?.textContent ?? '')`, 5000, 'your model, first')
      await ctx.chrome.js(`[...document.querySelectorAll('.dc-catalog__row')].find((r) => r.querySelector('.dc-catalog__id')?.textContent === 'kev-0.8b')?.querySelector('button')?.click()`)
      await waitFor(
        () =>
          ctx.settings
            .get()
            .decisions.models.map((m) => m.model)
            .join() === 'kev-latest,kev-0.8b',
        3000,
        'a model from the list is added after yours',
      )
      await ctx.chrome.until<boolean>(
        `return /Backup 1/.test(document.querySelector('.dc-models')?.textContent ?? '') && /Working: kev-0\\.8b answered/.test(document.querySelector('.dc-models')?.textContent ?? '')`,
        8000,
        'a model added is checked by itself, as a backup',
      )
      await ctx.chrome.js(`document.querySelector('[aria-label="Move kev-0.8b up"]')?.click()`)
      await waitFor(
        () =>
          ctx.settings
            .get()
            .decisions.models.map((m) => m.model)
            .join() === 'kev-0.8b,kev-latest',
        3000,
        'the order changes',
      )
    } finally {
      await ctx.chrome.invoke('decisions', 'clearComparisons').catch(() => undefined)
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    }
  },
}

// Settings › Quick decisions: nothing shows but the providers until one is
// connected; connecting one adds its suggested model, switches it on and
// checks it; a server of yours is a backup in your list; the switch turns it
// all off without losing the setup; Model and key keeps one row that opens
// the page.
const setupFlow: SmokeCheck = {
  name: 'decisions: the page sets up in order, checks itself, and Model and key opens it',
  async run(ctx) {
    const text = (): Promise<string> => ctx.chrome.js<string>(`return document.querySelector('.sp-main, main')?.textContent ?? document.body.textContent`)
    try {
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
      await openModelPage(ctx)
      await ctx.chrome.until<boolean>(`return /Use a decision model/.test(document.body.textContent) && new RegExp(${JSON.stringify(`Off: ${BRAND_NAME}’s own rules decide`)}).test(document.body.textContent)`, 5000, 'the switch says it is off')
      const early = /Your models|When you type and talk|Where it differed/.exec(await text())
      assert(!early, `nothing but the providers shows before one is connected (found “${early?.[0]}”)`)
      await ctx.chrome.js(`document.querySelector('[data-settings-anchor="decisions-provider-experiential"] button[aria-expanded]')?.click()`)
      await ctx.chrome.until<boolean>(`return !!document.querySelector('[data-settings-anchor="decisions-provider-experiential"] input[type="password"]')`, 3000, 'its key field opens')
      await ctx.chrome.js(
        `(() => { const i = document.querySelector('[data-settings-anchor="decisions-provider-experiential"] input[type="password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'xpl_smoke-not-a-real-key'); i.dispatchEvent(new Event('input', { bubbles: true })); i.form.requestSubmit() })()`,
      )
      await waitFor(() => ctx.settings.get().decisions.models.some((m) => m.provider === 'experiential' && m.model === 'clef-flash') && ctx.settings.get().decisions.on, 5000, 'connecting adds its suggested model and switches it on')
      await ctx.chrome.until<boolean>(
        `return /Working: clef-flash answered/.test(document.querySelector('.dc-models')?.textContent ?? '') && /When you type and talk/.test(document.body.textContent)`,
        8000,
        'checked by itself, then the switches show',
      )
      // A server of yours, added through the form, and its model picked from what it lists.
      const page = (js: string): Promise<unknown> => ctx.chrome.js(js)
      const setValue = (selector: string, value: string): string =>
        `(() => { const i = document.querySelector(${JSON.stringify(selector)}); const proto = i instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event(i instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })()`
      await page(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add a server')?.click()`)
      await ctx.chrome.until<boolean>(`return !!document.querySelector('input[aria-label="Name"]')`, 3000, 'the server form')
      await page(setValue('input[aria-label="Name"]', 'Smoke server'))
      await page(setValue('input[aria-label="Address"]', SMOKE_SERVER.servers[0]!.url))
      await page(`document.querySelector('input[aria-label="Address"]').form.requestSubmit()`)
      await waitFor(() => ctx.settings.get().decisions.servers.some((x) => x.name === 'Smoke server' && x.url === SMOKE_SERVER.servers[0]!.url), 5000, 'the server is added')
      const serverId = ctx.settings.get().decisions.servers[0]!.id
      assert(/^server-[a-z0-9]{10}$/.test(serverId), `a server gets an id of its own (got ${serverId})`)
      await ctx.chrome.until<boolean>(`return [...document.querySelectorAll('select[aria-label="Provider"] option')].some((o) => o.value === ${JSON.stringify(serverId)})`, 8000, 'its list in Add a model')
      await page(setValue('select[aria-label="Provider"]', serverId))
      await ctx.chrome.until<boolean>(`return [...document.querySelectorAll('.dc-catalog__row')].some((r) => r.querySelector('.dc-catalog__id')?.textContent === 'kev-latest')`, 5000, 'the server’s models')
      await page(`[...document.querySelectorAll('.dc-catalog__row')].find((r) => r.querySelector('.dc-catalog__id')?.textContent === 'kev-latest')?.querySelector('button')?.click()`)
      await waitFor(() => ctx.settings.get().decisions.models.some((m) => m.provider === serverId && m.model === 'kev-latest'), 5000, 'its model is added')
      await ctx.chrome.until<boolean>(`return /Backup 1/.test(document.querySelector('.dc-models')?.textContent ?? '') && /at Smoke server/.test(document.querySelector('.dc-models')?.textContent ?? '')`, 5000, 'your server’s model as a backup')
      await ctx.chrome.js(`document.querySelector('[data-settings-anchor="decisions-on"] [role="switch"], [data-settings-anchor="decisions-on"] input[type="checkbox"]')?.click()`)
      await waitFor(() => !ctx.settings.get().decisions.on, 3000, 'the switch turns it off')
      assert(!decider().active('needsYou') && ctx.settings.get().decisions.models.length === 2, 'off asks nothing and keeps your models')
      await openSettingsPage(ctx, 'model')
      await ctx.chrome.until<boolean>(`return /Off\\. A small decision model/.test(document.querySelector('[data-settings-anchor="decisions-summary"]')?.textContent ?? '')`, 5000, 'Model and key says it is off')
      ctx.settings.update({
        decisions: { ...ctx.settings.get().decisions, on: true },
      })
      await ctx.chrome.until<boolean>(`return /On: clef-flash at Experiential Labs, with 2 models in order/.test(document.querySelector('[data-settings-anchor="decisions-summary"]')?.textContent ?? '')`, 5000, 'Model and key says what is on')
      await ctx.chrome.js(`document.querySelector('[data-settings-anchor="decisions-summary"] button')?.click()`)
      await waitFor(
        () => {
          const snap = ctx.tabs.snapshot()
          return snap.tabs.some((t) => t.id === snap.activeId && t.url.startsWith('atelier://settings/decisions'))
        },
        5000,
        'its row opens Quick decisions',
      )
      // Removing the server takes its model out of your list.
      await ctx.chrome.until<boolean>(`return [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Remove')`, 5000, 'the server’s Remove')
      await ctx.chrome.js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove')?.click()`)
      const dialog = await docWith(ctx.chrome, '[role="alertdialog"]', 5000, 'the remove confirmation')
      await dialog.click(/^Remove$/, `document.querySelector('[role="alertdialog"]')`)
      await waitFor(() => ctx.settings.get().decisions.servers.length === 0 && ctx.settings.get().decisions.models.every((m) => !m.provider.startsWith('server-')), 5000, 'the server and its model are gone')

    } finally {
      await ctx.chrome.invoke('decisions', 'setKey', 'experiential', null).catch(() => undefined)
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    }
  },
}

// DC-17: the memory jobs ask "worth remembering?" only with the memory use on
// (off by default); the stand-in's sure yes keeps the chat.
const memoryFilter: SmokeCheck = {
  name: 'decisions: “worth remembering?” is asked only with the memory use on, and a sure yes keeps the chat',
  async run(ctx) {
    try {
      ctx.settings.update({ decisions: OWN_SERVER })
      assert(!decider().active('memory'), 'the memory use is off by default')
      ctx.settings.update({
        decisions: {
          ...OWN_SERVER,
          uses: { ...DECISIONS_DEFAULTS.uses, memory: true },
        },
      })
      assert(decider().active('memory'), 'the memory use is on once switched on')
      const skipped = await nothingToRemember([
        {
          id: 'a',
          text: '### Moving (2026-11-10)\n\nYou: I moved to Utrecht last week.\n\nPip: Noted!',
          messages: 2,
        },
      ])
      assert(skipped.size === 0, `a chat the model is sure about keeping stays in (got ${[...skipped].join(', ')})`)
    } finally {
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    }
  },
}

// DC-14: the address bar asks the new tab's search-or-ask question after a
// pause in typing. The stand-in is sure of "search", so the typed row keeps
// the top; a model sure of "ask" (swapped in here, read by the real
// question's cutoff) puts the Ask row first, and Enter asks the companion.
const BAR_GROUPS = `return [...document.querySelectorAll('.cb-row')].map((r) => r.getAttribute('data-group'))`

/** The app's decider, noting each search-or-ask text; with `ask`, a model sure it's a question answers instead. */
function watchSearchOrAsk(real: Decider, asked: string[], ask: boolean): Decider {
  const sure: DecisionResult = {
    answers: {
      intent: {
        type: 'choice',
        choice: 'ask',
        confidence: 0.95,
        probabilities: { search: 0.05, ask: 0.95 },
      },
    },
    model: 'smoke-model',
    source: 'model',
    ms: 1,
    inputTokens: 10,
  }
  return {
    decide: <T>(call: DecideCall<T>): Promise<T> => {
      if (call.use !== 'searchOrAsk') return real.decide(call)
      asked.push(call.excerpt ?? '')
      return ask ? Promise.resolve(call.rule).then((rule) => call.read(sure, rule) ?? rule) : real.decide(call)
    },
    active: (use) => real.active(use),
    ready: () => real.ready(),
    paused: () => real.paused(),
    ask: (caller, request, options) => real.ask(caller, request, options),
    model: (caller, request, options) => real.model(caller, request, options),
  }
}

/** Opens the command bar from the pill and returns its document (the interactive overlay). */
/**
 * Opens the command bar from the pill. A click that lands while the page is
 * still settling can open nothing (a slow CI runner), so it clicks again until
 * the bar is up, and gives the field a little longer than a fast Mac needs.
 */
async function openBar(ctx: SmokeContext): Promise<Chrome> {
  const deadline = Date.now() + 15_000
  while (!addressSmoke.surfaces().includes('command-bar')) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the command bar.')
    await ctx.chrome.js(`document.querySelector('.pill__text')?.click()`)
    await waitFor(() => addressSmoke.surfaces().includes('command-bar'), 3000, 'the command bar').catch(() => undefined)
  }
  return docWith(ctx.chrome, '.cb-field__input', 10_000, 'the command bar field', { overlayOnly: true })
}

const addressBarAsk: SmokeCheck = {
  name: 'decisions: the address bar asks after a pause, puts Ask first when the model is sure, and Enter asks',
  async run(ctx) {
    const real = decider()
    const asked: string[] = []
    const chatsBefore = new Set(ctx.chats.list().map((c) => c.id))
    ctx.server.route('/dc-bar', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Bar page</title><h1>Bar page</h1>')
    })
    const tab = ctx.tabs.create(`${ctx.server.http}/dc-bar`, {
      activate: true,
    })
    try {
      ctx.settings.update({ decisions: OWN_SERVER })
      await waitForPage(tab.view.webContents, 'the bar page', 8000, (at) => at.includes('/dc-bar'))
      setDecider(watchSearchOrAsk(real, asked, false))
      const bar = await openBar(ctx)
      // Typed in quick steps: one question after the pause, for the whole text.
      for (const step of ['pizza', 'pizza places', 'pizza places in utrecht']) await bar.type('.cb-field__input', step)
      await waitFor(() => asked.length > 0, 5000, 'the search-or-ask question after a pause')
      await sleep(500)
      assert(JSON.stringify(asked) === JSON.stringify(['pizza places in utrecht']), `asked once, for the whole text (got ${JSON.stringify(asked)})`)
      const searchFirst = await bar.until<string[]>(`const g = (() => { ${BAR_GROUPS} })(); return g.length ? g : null`, 10_000, 'the rows')
      assert(searchFirst[0] === 'typed', `a sure “search” keeps the typed row on top (got ${JSON.stringify(searchFirst)})`)
      await bar.escape()
      await waitFor(() => !addressSmoke.surfaces().includes('command-bar'), 5000, 'Esc to close the bar')

      setDecider(watchSearchOrAsk(real, asked, true))
      const again = await openBar(ctx)
      await again.type('.cb-field__input', 'plan a weekend in porto')
      const askFirst = await again.until<string[]>(`const g = (() => { ${BAR_GROUPS} })(); return g[0] === 'ask' ? g : null`, 10_000, 'the Ask row to move to the top')
      assert(askFirst[1] === 'typed', `the search follows the Ask row (got ${JSON.stringify(askFirst)})`)
      await again.js(`document.querySelector('.cb-field__input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
      await waitFor(() => ctx.chats.list().some((c) => !chatsBefore.has(c.id)), 8000, 'Enter to start a chat with the companion')
      assert(tab.view.webContents.getURL().includes('/dc-bar'), `Enter asked instead of searching (at ${tab.view.webContents.getURL()})`)
    } finally {
      setDecider(real)
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
      const started = ctx.chats
        .list()
        .filter((c) => !chatsBefore.has(c.id))
        .map((c) => c.id)
      await waitFor(() => started.every((id) => !ctx.host.isRunning(id)), 10_000, 'the chat to finish').catch(() => undefined)
      if (started.length) ctx.chats.remove(started)
      if (ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    }
  },
}

const sectionShot: ShotSpec = {
  name: 'decisions-settings',
  async run(ctx) {
    const at = async (selector: string, name: string): Promise<void> => {
      await ctx.chrome.js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`)
      await sleep(400)
      await ctx.shot(name)
    }
    try {
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
      await openModelPage(ctx)
      await at('[data-settings-anchor="decisions-on"]', 'decisions-settings-off')
      // Experiential Labs connected with its suggested model first, your own server's model as a backup.
      await ctx.chrome.invoke('decisions', 'setKey', 'experiential', 'xpl_smoke-not-a-real-key')
      ctx.settings.update({
        decisions: {
          ...SMOKE_SERVER,
          models: [{ provider: 'experiential', model: 'clef-flash' }, ...SMOKE_SERVER.models],
        },
      })
      await ctx.chrome.until<boolean>(`return !!document.querySelector('.dc-models') && !!document.querySelector('.dc-catalog__row')`, 8000, 'your models and the catalog')
      await at('[data-settings-anchor="decisions-on"]', 'decisions-settings')
      await at('[data-settings-anchor="decisions-models"]', 'decisions-settings-models')
      await at('.dc-catalog', 'decisions-settings-catalog')
      await at('[data-settings-anchor="decisions-uses"]', 'decisions-settings-uses')
      await openSettingsPage(ctx, 'model')
      await at('[data-settings-anchor="decisions-summary"]', 'decisions-settings-summary')
    } finally {
      await ctx.chrome.invoke('decisions', 'setKey', 'experiential', null)
      ctx.settings.update({ decisions: DECISIONS_DEFAULTS })
    }
  },
}

export const decisionsSmoke: SmokeGroup = {
  group: 'DECISIONS',
  checks: [offKeepsRules, ownServer, setupFlow, memoryFilter, addressBarAsk, groupTabsCheck, effortPerMessageCheck],
  shots: [sectionShot],
}
