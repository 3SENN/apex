/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents, WebFrameMain } from 'electron'
import { STILLNESS_MS, type PickResult } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import type { AutofillSurfaceId } from '@shared/overlay/autofill'
import { resolveAnchorRect, toCssPx } from '@shared/overlayLayout'
import type { CredentialView } from '@shared/passwords'
import { agentFocusedGuard, agentGuardedAt } from '../autofill/agentGuard'
import { autofillSmoke } from '../autofill'
import { overlayPresenter } from '../autofill/presenter'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { crossSiteFixtures } from './fixtures'

// Autofill in pages on both fixture origins. A login is
// saved after sign-in, then filled after a reload once the popup has been
// still for 500 ms; a split login fills its password page; a signup takes the
// generated password; a checkout fills a card inside a cross-origin frame
// after the (smoke) authenticator says yes; an address form fills; agent tabs
// get no popup; and the agent is refused on guarded fields. Offline: fixture
// pages on 127.0.0.1 and localhost, the smoke cipher and the smoke authenticator.
// Every name, card and address below is made up for these fixtures.

const USER = 'smoke-user@example.invalid'
const PASS = 'Fixture-Pass-42'
const CARD = { number: '4242424242424242', holder: 'Fixture Tester', expMonth: 12, expYear: 2031 }

const STYLE = '<style>body{font:14px system-ui,sans-serif;margin:32px;color:#222;background:#fafafa}label{display:block;margin:0 0 14px}input,select{display:block;margin-top:4px;width:260px;height:28px;box-sizing:border-box}</style>'
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${STYLE}<body>${body}</body></html>`
const go = (to: string): string => `onsubmit="event.preventDefault(); location.href='${to}'"`

const PAGES = {
  login: page('Fixture sign-in', `<h1>Sign in</h1><form id="f" ${go('/af/welcome.html')}><label>Email <input id="user" name="email" type="email" autocomplete="username"></label><label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label><button id="go">Sign in</button></form>`),
  welcome: page('Fixture welcome', '<h1>Welcome back</h1><p>Signed in.</p>'),
  split1: page('Fixture split sign-in', `<h1>Sign in</h1><form ${go('/af/split-2.html')}><label>Email <input id="user" name="email" type="email" autocomplete="username"></label><button>Next</button></form>`),
  split2: page('Fixture split sign-in, step 2', `<h1>Enter your password</h1><form ${go('/af/welcome.html')}><label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`),
  signup: page('Fixture signup', `<h1>Create an account</h1><form ${go('/af/welcome.html')}><label>Email <input id="user" name="email" type="email" autocomplete="username"></label><label>Choose a password <input id="pass" name="new" type="password" autocomplete="new-password"></label><button>Create</button></form>`),
  card: page('Fixture card frame', `<form ${go('/af/paid.html')}><label>Card number <input id="num" autocomplete="cc-number" inputmode="numeric"></label><label>Name on card <input id="name" autocomplete="cc-name"></label><label>Expiry <input id="exp" autocomplete="cc-exp" placeholder="MM/YY"></label><label>Security code <input id="csc" autocomplete="cc-csc"></label><button>Pay</button></form>`),
  paid: page('Fixture paid', '<p>Paid.</p>'),
  address: page('Fixture address', `<h1>Delivery address</h1><form ${go('/af/welcome.html')}><label>First name <input id="given" autocomplete="given-name"></label><label>Last name <input id="family" autocomplete="family-name"></label><label>Street <input id="street" autocomplete="address-line1"></label><label>Postcode <input id="zip" autocomplete="postal-code"></label><label>City <input id="city" autocomplete="address-level2"></label><button>Continue</button></form>`),
}

interface Opened {
  surface: AutofillSurfaceId
  /** Where the controller placed it, in the tab pane's coordinates. */
  rect: Bounds
  props: Record<string, unknown>
  id: string
  tabId: string
}

/** Records every surface autofill opens, and still draws it through the real overlay host. */
const opened: Opened[] = []
function record(): void {
  autofillSmoke.presenter = (win, tabId) => {
    const real = overlayPresenter(win, tabId)
    return {
      open(surface, rect, props, id) {
        opened.push({ surface, rect, props: props as unknown as Record<string, unknown>, id, tabId })
        return real.open(surface, rect, props, id)
      },
    }
  }
}

async function fixtures(ctx: SmokeContext): Promise<{ primary: (p: string) => string; second: (p: string) => string }> {
  const f = await crossSiteFixtures(ctx.server)
  const add = (origin: 'primary' | 'second') => (name: keyof typeof PAGES | string, html?: string): string => f.addFixture(`/af/${name}.html`, html ?? PAGES[name as keyof typeof PAGES], origin)
  const primary = add('primary')
  const second = add('second')
  for (const name of ['login', 'welcome', 'signup'] as const) {
    primary(name)
    second(name)
  }
  primary('split1')
  primary('split-2', PAGES.split2)
  primary('address')
  second('card')
  second('paid')
  const cardFrame = `${f.second}/af/card.html`
  primary('checkout', page('Fixture checkout', `<h1>Checkout</h1><p>Payment is handled by another site:</p><iframe id="pay" src="${cardFrame}" style="width:420px;height:300px;border:1px solid #ccc"></iframe>`))
  primary('paid', PAGES.paid)
  return { primary: (p) => `${f.primary}/af/${p}.html`, second: (p) => `${f.second}/af/${p}.html` }
}

async function open(ctx: SmokeContext, url: string): Promise<{ tab: Tab; wc: WebContents }> {
  const tab = ctx.tabs.create(url, { activate: true })
  const wc = tab.view.webContents
  try {
    await waitForPage(wc, `the fixture ${url}`, 8000, (at) => at === url)
  } catch (err) {
    // A tab that never loaded must not stay behind for the next check.
    ctx.tabs.close(tab.id)
    throw err
  }
  return { tab, wc }
}

async function navigated(wc: WebContents, path: string): Promise<void> {
  await waitForPage(wc, `the page to reach ${path}`, 8000, (at) => new URL(at).pathname === path)
}

async function rectIn(frame: WebFrameMain, selector: string): Promise<Bounds> {
  return frame.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`) as Promise<Bounds>
}

/** A real click (a trusted, user-started focus) at a point in the tab, in CSS px of the top frame. */
async function clickAt(wc: WebContents, x: number, y: number): Promise<void> {
  const at = { x: Math.round(x), y: Math.round(y) }
  // Input reaches a view that has focus, even while the window itself is in the background.
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', ...at })
  wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  await sleep(120)
}

async function clickField(wc: WebContents, selector: string, frame: WebFrameMain = wc.mainFrame, offset = { x: 0, y: 0 }): Promise<void> {
  const r = await rectIn(frame, selector)
  await clickAt(wc, offset.x + r.x + 12, offset.y + r.y + r.height / 2)
  // With the screen locked nothing is composited, so a synthetic click has no hit
  // test to land on; the field then takes focus from a script run as a user gesture.
  const sel = JSON.stringify(selector)
  const landed = (await frame.executeJavaScript(`document.activeElement === document.querySelector(${sel})`)) as boolean
  if (!landed) {
    await frame.executeJavaScript(`(() => { const el = document.querySelector(${sel}); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.focus(); el.click(); return true })()`, true)
    await sleep(120)
  }

}

async function typeText(wc: WebContents, text: string): Promise<void> {
  await wc.insertText(text)
  await sleep(200)
}

async function pressEnter(wc: WebContents): Promise<void> {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await sleep(100)
}

function value(frame: WebFrameMain, selector: string): Promise<string> {
  return frame.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`) as Promise<string>
}

/** Waits for the tab's current fill popup or card of `surface`. */
async function surfaceOf(tab: Tab, surface: AutofillSurfaceId, since: number): Promise<Opened> {
  let found: Opened | undefined
  await waitFor(
    () => {
      const c = autofillSmoke.controller?.(tab.id)
      found = opened.slice(since).reverse().find((o) => o.tabId === tab.id && o.surface === surface && (o.id === c?.popupId || o.id === c?.offerId))
      return found !== undefined
    },
    6000,
    `the ${surface} surface`,
  ).catch((err: unknown) => {
    // Say what did open, so a miss is diagnosable from the run log.
    const c = autofillSmoke.controller?.(tab.id)
    const seen = opened.slice(since).map((o) => `${o.surface}${o.tabId === tab.id ? '' : '(other tab)'}`)
    throw new Error(`${err instanceof Error ? err.message : String(err)} Opened since: [${seen.join(', ')}]; popup ${c?.popupId ?? 'none'}, offer ${c?.offerId ?? 'none'}; last focus: ${c?.lastFocus ?? 'no controller'}.`)
  })
  return found as Opened
}

/**
 * Where the overlay draws a popup, in window CSS px: the rect the real popup
 * reports as shown (FillPopup sends its host's anchor rect, resolved from the
 * tab pane exactly like this).
 */
function drawnRect(ctx: SmokeContext, popup: Opened): Bounds {
  const zoom = ctx.chrome.ui.getZoomFactor() || 1
  const rect = resolveAnchorRect({ kind: 'tab', tabId: popup.tabId, rect: popup.rect }, (tabId) => {
    const pane = ctx.tabs.paneBounds(tabId)
    return pane ? toCssPx(pane, zoom) : null
  })
  assert(rect, 'the popup’s tab has a pane to draw over')
  return rect
}

/** A pick right away is refused; after the popup was shown and still for 500 ms it counts. */
async function pickWhenStill(ctx: SmokeContext, popup: Opened, rowId: string): Promise<PickResult> {
  const svc = autofillSmoke.services
  assert(svc, 'the autofill service is running')
  const early = await svc.pick(popup.id, rowId)
  assert(early === 'too-soon', `a pick before the popup has been still is refused (got ${early})`)
  // Stands in for the popup's own report when the overlay can't paint (a locked screen). It names the
  // same rect the real popup reports, so whichever lands second is no move: a different rect (the field's)
  // restarted the stillness wait whenever the overlay painted after this, and the pick came too soon.
  svc.surfaceShown(popup.id, drawnRect(ctx, popup))
  await sleep(STILLNESS_MS + 150)
  return svc.pick(popup.id, rowId)
}

async function savedLogins(ctx: SmokeContext): Promise<CredentialView[]> {
  await ctx.chrome.invoke('passwords', 'unlock')
  return ctx.chrome.invoke<CredentialView[]>('passwords', 'list')
}

function close(ctx: SmokeContext, ...tabs: Tab[]): void {
  for (const tab of tabs) ctx.tabs.close(tab.id)
}

const importHint: SmokeCheck = {
  name: 'autofill: the one-time import hint on a sign-in page with nothing saved',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    const before = ctx.settings.get().autofill
    ctx.settings.update({ autofill: { passwordsImported: false, importHintDismissed: false } })
    // The hint shows once a session; an earlier screenshot may already have used it up.
    autofillSmoke.resetImportHint?.()
    const { tab, wc } = await open(ctx, pages.second('login'))
    try {
      // The first page of the second origin reports straight away: no reload first.
      const since = opened.length
      await clickField(wc, '#pass')
      await surfaceOf(tab, 'password-import-hint', since)
      autofillSmoke.services?.dismissImportHint()
      assert(ctx.settings.get().autofill.importHintDismissed, 'the dismissal is remembered')
    } finally {
      ctx.settings.update({ autofill: { passwordsImported: before.passwordsImported } })
      close(ctx, tab)
    }
  },
}

const saveAndFill: SmokeCheck = {
  name: 'autofill: save after sign-in, reload, focus, pick after 500 ms, filled',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    const { tab, wc } = await open(ctx, pages.primary('login'))
    try {
      await clickField(wc, '#user')
      await typeText(wc, USER)
      await clickField(wc, '#pass')
      await typeText(wc, PASS)
      const since = opened.length
      await pressEnter(wc)
      await navigated(wc, '/af/welcome.html')
      const offer = await surfaceOf(tab, 'save-login', since)
      const fields = offer.props.fields as Array<{ key: string; value: string; masked?: boolean }>
      assert(fields.find((f) => f.key === 'username')?.value === USER, 'the card shows the typed username')
      assert(fields.find((f) => f.key === 'password')?.masked === true, 'the password stays masked')
      await autofillSmoke.services?.respondOffer(offer.id, 'save')
      assert((await savedLogins(ctx)).some((c) => c.username === USER), 'the login was saved')

      void wc.loadURL(pages.primary('login')).catch(() => undefined)
      await navigated(wc, '/af/login.html')
      const at = opened.length
      await clickField(wc, '#user')
      const popup = await surfaceOf(tab, 'autofill-login', at)
      const rows = popup.props.rows as Array<{ id: string; kind: string; title: string }>
      const row = rows.find((r) => r.kind === 'login' && r.title === USER)
      assert(row, 'the saved login is offered')
      assert(rows.some((r) => r.kind === 'manage'), 'a manage link is offered')
      assert(!JSON.stringify(popup.props).includes(PASS), 'the popup never carries the password')
      assert((await pickWhenStill(ctx, popup, row.id)) === 'filled', 'the pick filled')
      await sleep(150)
      assert((await value(wc.mainFrame, '#user')) === USER, 'the username is filled')
      assert((await value(wc.mainFrame, '#pass')) === PASS, 'the password is filled')
    } finally {
      close(ctx, tab)
    }
  },
}

const splitLogin: SmokeCheck = {
  name: 'autofill: a split login fills its password page',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    const { tab, wc } = await open(ctx, pages.primary('split1'))
    try {
      await clickField(wc, '#user')
      await typeText(wc, USER)
      // The saved login's popup is open on the username; Esc closes it so Return submits.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      await sleep(150)
      await pressEnter(wc)
      await navigated(wc, '/af/split-2.html')
      const since = opened.length
      await clickField(wc, '#pass')
      const popup = await surfaceOf(tab, 'autofill-login', since)
      const rows = popup.props.rows as Array<{ id: string; title: string }>
      const preselected = rows.find((r) => r.id === popup.props.activeId)
      assert(preselected?.title === USER, 'the first page’s username is preselected')
      assert((await pickWhenStill(ctx, popup, preselected.id)) === 'filled', 'the pick filled')
      await sleep(150)
      assert((await value(wc.mainFrame, '#pass')) === PASS, 'the password page is filled')
    } finally {
      close(ctx, tab)
    }
  },
}

const generated: SmokeCheck = {
  name: 'autofill: a signup takes the generated password',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    const { tab, wc } = await open(ctx, pages.second('signup'))
    try {
      const since = opened.length
      await clickField(wc, '#pass')
      const popup = await surfaceOf(tab, 'autofill-login', since)
      assert((popup.props.rows as Array<{ kind: string }>).some((r) => r.kind === 'generated'), 'a strong password is offered')
      assert((await pickWhenStill(ctx, popup, 'generated')) === 'filled', 'the pick filled')
      await sleep(150)
      const filled = await value(wc.mainFrame, '#pass')
      assert(filled.length >= 12 && filled !== PASS, `a generated password was filled (${filled.length} characters)`)
    } finally {
      close(ctx, tab)
    }
  },
}

const crossOriginCard: SmokeCheck = {
  name: 'autofill: a checkout fills a card inside a cross-origin frame after auth',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    await ctx.chrome.invoke('wallet', 'saveCard', CARD)
    const { tab, wc } = await open(ctx, pages.primary('checkout'))
    try {
      await waitFor(() => wc.mainFrame.frames.some((f) => f.url.endsWith('/af/card.html') && !f.isDestroyed()), 8000, 'the card frame')
      const frame = wc.mainFrame.frames.find((f) => f.url.endsWith('/af/card.html')) as WebFrameMain
      await waitFor(async () => (await frame.executeJavaScript('document.readyState')) === 'complete', 8000, 'the card frame to load')
      const box = await rectIn(wc.mainFrame, '#pay')
      const since = opened.length
      // The iframe's border is 1 px.
      await clickField(wc, '#num', frame, { x: box.x + 1, y: box.y + 1 })
      const popup = await surfaceOf(tab, 'autofill-card', since)
      assert(typeof popup.props.embeddingSite === 'string' && popup.props.embeddingSite !== popup.props.siteLabel, 'the popup names the frame’s site and the embedding site')
      const rows = popup.props.rows as Array<{ id: string; kind: string; title: string }>
      const row = rows.find((r) => r.kind === 'card' && r.title.endsWith('4242'))
      assert(row, 'the saved card is offered by network and last four')
      const anchor = popup.props.anchorRect as Bounds
      assert(anchor.y > box.y && anchor.x >= box.x, 'the popup lines up with the field inside the frame')
      const picked = await pickWhenStill(ctx, popup, row.id)
      assert(picked === 'filled', `the pick filled after auth (got ${picked})`)
      await sleep(150)
      assert((await value(frame, '#num')).replace(/\D/g, '') === CARD.number, 'the number is filled in the frame')
      assert((await value(frame, '#name')) === CARD.holder, 'the name is filled')
      assert((await value(frame, '#exp')) === '12/31', 'the expiry is filled')
      assert((await value(frame, '#csc')) === '', 'the security code is never filled')
    } finally {
      close(ctx, tab)
    }
  },
}

const addressFill: SmokeCheck = {
  name: 'autofill: an address form fills',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    await ctx.chrome.invoke('wallet', 'saveAddress', { givenName: 'Fixture', additionalName: '', familyName: 'Tester', organization: '', line1: 'Proefstraat 1', line2: '', line3: '', city: 'Gent', region: '', postalCode: '9000', country: 'BE', email: '', tel: '' })
    const { tab, wc } = await open(ctx, pages.primary('address'))
    try {
      const since = opened.length
      await clickField(wc, '#street')
      const popup = await surfaceOf(tab, 'autofill-address', since)
      const row = (popup.props.rows as Array<{ id: string; kind: string; title: string }>).find((r) => r.kind === 'address' && r.title === 'Fixture Tester')
      assert(row, 'the saved address is listed by name')
      assert((await pickWhenStill(ctx, popup, row.id)) === 'filled', 'the pick filled')
      await sleep(150)
      assert((await value(wc.mainFrame, '#street')) === 'Proefstraat 1', 'the street is filled')
      assert((await value(wc.mainFrame, '#zip')) === '9000', 'the postcode is filled')
      assert((await value(wc.mainFrame, '#city')) === 'Gent', 'the city is filled')
    } finally {
      close(ctx, tab)
    }
  },
}

const agentTabs: SmokeCheck = {
  name: 'autofill: no popup on agent tabs, and the agent is refused on guarded fields',
  async run(ctx) {
    record()
    const pages = await fixtures(ctx)
    const { tab, wc } = await open(ctx, pages.primary('login'))
    try {
      ctx.tabs.setAgentControlled(tab.id, true)
      const since = opened.length
      await clickField(wc, '#user')
      await sleep(600)
      assert(!opened.slice(since).some((o) => o.tabId === tab.id), 'an agent tab gets no fill popup')
      await clickField(wc, '#pass')
      assert((await agentFocusedGuard(tab.id)) === 'password', 'the focused password field is guarded for the agent')
      const r = await rectIn(wc.mainFrame, '#pass')
      const zoom = wc.getZoomFactor() || 1
      assert(await agentGuardedAt(tab.id, { x: (r.x + r.width / 2) * zoom, y: (r.y + r.height / 2) * zoom }), 'the masker covers the password field')
      const area = await autofillSmoke.controller?.(tab.id)?.guardedRects()
      assert(area && !area.unresolved && area.rects.length >= 1, 'guarded rects are known for captures')
    } finally {
      ctx.tabs.setAgentControlled(tab.id, false)
      close(ctx, tab)
    }
  },
}

export const checks: SmokeCheck[] = [importHint, saveAndFill, splitLogin, generated, crossOriginCard, addressFill, agentTabs]

export const shots: ShotSpec[] = [
  {
    name: 'autofill-login-popup',
    async run(ctx) {
      record()
      const pages = await fixtures(ctx)
      const { tab, wc } = await open(ctx, pages.primary('login'))
      try {
        const since = opened.length
        await clickField(wc, '#user')
        await surfaceOf(tab, 'autofill-login', since)
        await sleep(300)
        await ctx.shot('autofill-login-popup')
      } finally {
        close(ctx, tab)
      }
    },
  },
  {
    name: 'autofill-save-login',
    async run(ctx) {
      record()
      const pages = await fixtures(ctx)
      const { tab, wc } = await open(ctx, pages.second('login'))
      try {
        await clickField(wc, '#user')
        await typeText(wc, 'another-user@example.invalid')
        await clickField(wc, '#pass')
        await typeText(wc, 'Another-Fixture-7')
        const since = opened.length
        await pressEnter(wc)
        await navigated(wc, '/af/welcome.html')
        const offer = await surfaceOf(tab, 'save-login', since)
        await sleep(300)
        await ctx.shot('autofill-save-login')
        await autofillSmoke.services?.respondOffer(offer.id, 'dismiss')
      } finally {
        close(ctx, tab)
      }
    },
  },
]
