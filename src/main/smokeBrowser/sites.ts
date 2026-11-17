/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SiteInfo, SiteSettings } from '@shared/sites'
import { sitesSmoke } from '../features/sites'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'
import { errorChecks, errorShots } from './sitesErrors'

// The sites smoke checks and light and dark shots:
// the per-site store, one shared prompt per request that ends with its tab,
// refusals on the agent's tabs, site info, and shots of the prompt, site
// info, the screen picker, the device chooser, the sharing bar and Site
// settings. Pages come from the 127.0.0.1 fixture server only.

const PAGE = '<!doctype html><title>Apex sites fixture</title><body style="font:16px system-ui;padding:24px">A page that asks for things.</body>'

/** Opens the fixture page in a new tab and waits for it to load. */
async function fixtureTab(ctx: SmokeContext, activate = true): Promise<Tab> {
  ctx.server.route('/sites-fixture', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  })
  const tab = ctx.tabs.create(`${ctx.server.http}/sites-fixture`, { activate })
  await waitForPage(tab.view.webContents, 'the sites fixture page', 8000, (at) => at.endsWith('/sites-fixture'))
  return tab
}

/** Runs script in the page as if the person clicked (pickers and choosers need a gesture). Never waits for the page's promise. */
function inPage(tab: Tab, script: string): void {
  void tab.view.webContents.executeJavaScript(`(() => { ${script}; return true })()`, true).catch(() => undefined)
}

async function surfaceOpen(tab: Tab, surface: string, what: string): Promise<void> {
  await waitFor(() => sitesSmoke.surfaces(tab).includes(surface), 5000, what)
  // Let it settle in (entry motion) before a shot.
  await sleep(250)
}

function closeTab(ctx: SmokeContext, tab: Tab): void {
  if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

const storeRoundTrip: SmokeCheck = {
  name: 'sites: per-site settings round-trip through the service',
  async run(ctx) {
    const origin = 'https://sites-smoke.example'
    await ctx.chrome.invoke('sites', 'set', origin, { permissions: { notifications: 'block' }, sound: 'block' })
    // The service takes an origin (schemas/sites.ts); a page URL is refused at IPC.
    const decision = await ctx.chrome.invoke<string>('sites', 'permission', origin, 'notifications')
    assert(decision === 'block', `a stored block reads back for the site (got ${decision})`)
    const refused = await ctx.chrome.invoke('sites', 'permission', `${origin}/some/page`, 'notifications').then(() => false, () => true)
    assert(refused, 'a page URL is refused where an origin is expected')
    const listed = await ctx.chrome.invoke<{ origin: string; overrides: number }[]>('sites', 'list')
    assert(listed.some((e) => e.origin === origin && e.overrides === 2), 'the site is listed with two overrides')
    await ctx.chrome.invoke('sites', 'forget', origin)
    const after = await ctx.chrome.invoke<SiteSettings>('sites', 'get', origin)
    assert(after.sound === 'default' && Object.keys(after.permissions).length === 0, 'forgetting a site resets it')
  },
}

const sharedPrompt: SmokeCheck = {
  name: 'sites: identical requests share one prompt, which ends with its tab',
  async run(ctx) {
    const tab = await fixtureTab(ctx)
    try {
      inPage(tab, 'Notification.requestPermission(); Notification.requestPermission()')
      await surfaceOpen(tab, 'permission-prompt', 'the permission prompt')
      const mine = sitesSmoke.prompts().filter((p) => p.tabId === tab.id)
      assert(mine.length === 1 && mine[0]!.open, `one prompt for both requests (got ${mine.length})`)
    } finally {
      closeTab(ctx, tab)
    }
    await waitFor(() => sitesSmoke.prompts().every((p) => p.tabId !== tab.id), 3000, 'the prompt to end with its tab')
  },
}

const agentRefused: SmokeCheck = {
  name: 'sites: requests on an agent-controlled tab are refused without a prompt',
  async run(ctx) {
    const tab = await fixtureTab(ctx, false)
    try {
      ctx.tabs.setAgentControlled(tab.id, true)
      const answer = await tab.view.webContents.executeJavaScript('Notification.requestPermission()', true)
      assert(answer === 'denied', `the agent's tab is refused (got ${String(answer)})`)
      assert(sitesSmoke.prompts().every((p) => p.tabId !== tab.id), 'no prompt opened for the agent')
    } finally {
      ctx.tabs.setAgentControlled(tab.id, false)
      closeTab(ctx, tab)
    }
  },
}

const siteInfo: SmokeCheck = {
  name: 'sites: site info describes the page',
  async run(ctx) {
    const tab = await fixtureTab(ctx, false)
    try {
      const info = await ctx.chrome.invoke<SiteInfo>('sites', 'info', tab.id)
      assert(info.origin === new URL(ctx.server.http).origin, `site info names the origin (got ${info.origin})`)
      assert(info.security === 'insecure', `a plain http page is not secure (got ${info.security})`)
    } finally {
      closeTab(ctx, tab)
    }
  },
}

export const checks: SmokeCheck[] = [
  storeRoundTrip,
  sharedPrompt,
  agentRefused,
  siteInfo,
  ...errorChecks,
]

/** A shot of a surface a page request opens, closing the tab afterwards (which closes the surface). */
function requestShot(name: string, surface: string, script: string): ShotSpec {
  return {
    name,
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        inPage(tab, script)
        await surfaceOpen(tab, surface, `the ${surface} surface`)
        await ctx.shot(name)
      } finally {
        closeTab(ctx, tab)
      }
    },
  }
}

export const shots: ShotSpec[] = [
  requestShot('sites-prompt', 'permission-prompt', 'navigator.geolocation.getCurrentPosition(() => {}, () => {})'),
  requestShot('sites-screen-picker', 'screen-picker', 'navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).catch(() => {})'),
  requestShot('sites-device-chooser', 'device-chooser', 'navigator.hid && navigator.hid.requestDevice({ filters: [] }).catch(() => {})'),
  {
    name: 'sites-info',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        await sitesSmoke.openSiteInfo(tab)
        await surfaceOpen(tab, 'site-info', 'site info')
        await ctx.shot('sites-info')
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'sites-sharing-bar',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        // Smoke has no camera: mark the tab as capturing, as a granted call would.
        sitesSmoke.capture.grant(tab.id, ['camera', 'microphone'])
        await surfaceOpen(tab, 'sharing-bar', 'the sharing bar')
        await ctx.shot('sites-sharing-bar')
      } finally {
        sitesSmoke.capture.clear(tab.id)
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'sites-settings',
    async run(ctx) {
      ctx.tabs.openInternal('apex://settings/sites')
      await ctx.chrome.until(`return document.querySelector('.ss-add')`, 8000, 'Settings › Sites')
      await ctx.shot('sites-settings')
    },
  },
  ...errorShots,
]
