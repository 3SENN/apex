/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow } from 'electron'
import { menuContributions } from '@shared/menuModel'
import type { LoginItemState } from '@shared/system'
import { assert, docWith, sleep, waitFor } from '../smokeKit'
import { backgroundPolicy } from '../system/background'
import { FakeLoginItem } from '../system/loginItem'
import { currentSystemRuntime, type SystemRuntime } from '../system/service'
import { parseLaunchArgs } from '../system/secondInstance'
import { TRAY_IDS } from '../system/tray'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'
import type { SmokeContext } from '../smokeBrowser/types'

// The login item through a fake (setLoginItemSettings is never called),
// background mode keeping Atelier alive with a tray and Open Atelier bringing the
// window back, the tray menu, second launches, and shots of the General rows
// and the approval dialog. Offline only. ⌘Q is not pressed: it would end the
// run; the policy's quit rule is unit-tested.

function runtime(): SystemRuntime {
  const r = currentSystemRuntime()
  assert(r, 'the system runtime is not running')
  return r
}

function fake(): FakeLoginItem {
  const backend = runtime().backend()
  assert(backend instanceof FakeLoginItem, 'smoke must read the login item through the fake')
  return backend
}

const DISABLED: LoginItemState = { supported: true, openAtLogin: false, status: 'disabled' }

async function openGeneral(ctx: SmokeContext): Promise<void> {
  ctx.tabs.openInternal('atelier://settings/general')
  await ctx.chrome.until<boolean>(`return Boolean(document.querySelector('[data-settings-anchor="open-at-login"] [role="switch"]'))`, 8000, 'the General page’s open-at-login row')
}

export const checks: SmokeCheck[] = [
  {
    name: 'system: the login item is read through a fake, and requires-approval opens Login Items',
    async run(ctx) {
      const login = fake()
      login.seed(DISABLED)
      const first = await ctx.chrome.invoke<LoginItemState>('system', 'loginItem')
      assert(first.status === 'disabled' && first.supported, `unexpected login item ${JSON.stringify(first)}`)
      // Linux starts at login through an autostart entry, which needs nobody's approval: on and off is all there is.
      if (process.platform === 'linux') {
        login.seed({ supported: true, openAtLogin: true, status: 'enabled' }, true)
        const on = await ctx.chrome.invoke<LoginItemState>('system', 'setOpenAtLogin', true)
        assert(on.status === 'enabled', `expected enabled, got ${on.status}`)
        login.seed(DISABLED, true)
        const off = await ctx.chrome.invoke<LoginItemState>('system', 'setOpenAtLogin', false)
        assert(off.status === 'disabled', 'turning it off did not stick')
        return
      }
      login.seed({ supported: true, openAtLogin: true, status: 'requires-approval' }, true)
      const asked = await ctx.chrome.invoke<LoginItemState>('system', 'setOpenAtLogin', true)
      assert(asked.status === 'requires-approval', `expected requires-approval, got ${asked.status}`)
      await ctx.chrome.invoke('system', 'openLoginItemsSettings')
      if (process.platform === 'darwin') assert(runtime().record.opened.at(-1)?.startsWith('x-apple.systempreferences:'), 'Login Items settings were not requested')
      // Approved in System Settings, then back: a recheck reads enabled.
      login.seed({ supported: true, openAtLogin: true, status: 'enabled' })
      const back = await ctx.chrome.invoke<LoginItemState>('system', 'loginItem')
      assert(back.status === 'enabled', `expected enabled after approval, got ${back.status}`)
      const off = await ctx.chrome.invoke<LoginItemState>('system', 'setOpenAtLogin', false)
      assert(off.status === 'disabled', 'turning it off did not stick')
    },
  },
  {
    name: 'system: the tray menu is the tray contributions, with Open, New Window, New Chat, the status line and Quit',
    async run() {
      assert(menuContributions('tray').some((c) => c.id === 'system:tray'), 'system:tray is not contributed')
      const ids = runtime().trayItems().map((i) => i.id)
      for (const id of [TRAY_IDS.open, TRAY_IDS.newWindow, TRAY_IDS.newChat, TRAY_IDS.status, TRAY_IDS.quit]) assert(ids.includes(id), `the tray menu lacks ${id}`)
    },
  },
  {
    name: 'system: with background mode on, the last window closing keeps Atelier running with a tray; Open Atelier brings it back',
    async run(ctx) {
      const r = runtime()
      const win = BrowserWindow.fromWebContents(ctx.chrome.ui)
      assert(win, 'no chrome window')
      // A Linux desktop without a tray host: background mode stays off (its row is hidden), so Atelier never runs invisibly.
      if (!r.trayAvailable()) {
        assert(process.platform === 'linux', 'only a Linux desktop can lack a tray')
        ctx.settings.update({ runInBackground: true })
        try {
          assert(!r.runInBackground(), 'background mode took effect without a tray to come back from')
          assert(backgroundPolicy({ platform: 'linux', runInBackground: r.runInBackground(), windowCount: 0, quitting: false, openedAtLogin: false }) === 'quit', 'closing the last window would leave Atelier running invisibly')
          assert(!r.trayShown, 'a tray icon was shown without a tray host')
        } finally {
          ctx.settings.update({ runInBackground: false })
        }
        return
      }
      ctx.settings.update({ runInBackground: true })
      await waitFor(() => r.trayShown, 3000, 'the tray icon')
      const notices = r.record.notices
      try {
        // Stand in for closing it: smoke drives this window, so it is hidden instead.
        win.hide()
        await waitFor(() => !win.isVisible(), 3000, 'the window to hide')
        assert(r.windowAllClosed(), 'background mode let Atelier quit')
        assert(r.trayShown, 'no tray icon while windowless')
        if (process.platform === 'darwin') assert(r.dockHidden, 'the Dock icon stayed while windowless')
        assert(r.record.notices <= notices + 1, 'the still-running notice showed more than once')
        await r.runTrayItem({ id: TRAY_IDS.open })
        await waitFor(() => win.isVisible(), 3000, 'Open Atelier to show the window')
        assert(!r.dockHidden, 'the Dock icon did not come back with the window')
        // A second time stays quiet: the notice is once ever.
        win.hide()
        await waitFor(() => !win.isVisible(), 3000, 'the window to hide again')
        r.windowAllClosed()
        assert(r.record.notices <= notices + 1, 'the still-running notice showed again')
        await r.runTrayItem({ id: TRAY_IDS.open })
        await waitFor(() => win.isVisible(), 3000, 'the window to come back again')
      } finally {
        if (!win.isVisible()) win.show()
        ctx.settings.update({ runInBackground: false })
      }
      await waitFor(() => !r.trayShown, 3000, 'the tray icon to go with background mode')
      // Without background mode the last window closing quits (not exercised: it would end the run).
      assert(r.decide({ openedAtLogin: false }) === 'none', 'a visible window must not quit')
    },
  },
  {
    name: 'system: a second launch opens its http and file URLs as tabs and ignores flags',
    async run(ctx) {
      ctx.server.page('/e4-second-instance', '<!doctype html><title>Second launch</title><p>Opened by a second launch.</p>')
      const url = `${ctx.server.http}/e4-second-instance`
      const targets = parseLaunchArgs(['atelier', '--allow-file-access-from-files', '--background', url], { cwd: process.cwd(), platform: process.platform })
      assert(targets.urls.length === 1 && targets.urls[0] === url, `unexpected targets ${JSON.stringify(targets)}`)
      const before = new Set(ctx.tabs.all().map((t) => t.id))
      runtime().handleLaunch(targets)
      await waitFor(() => ctx.tabs.all().some((t) => !before.has(t.id) && t.view.webContents.getURL().startsWith(url)), 5000, 'the launched URL in a tab')
      for (const tab of ctx.tabs.all().filter((t) => !before.has(t.id))) ctx.tabs.close(tab.id)
    },
  },
]

export const shots: ShotSpec[] = [
  {
    name: 'e4 General rows',
    async run(ctx) {
      fake().seed(DISABLED)
      await openGeneral(ctx)
      await ctx.chrome.js(`document.querySelector('[data-settings-anchor="open-at-login"]').scrollIntoView({ block: 'center' })`)
      await sleep(300)
      await ctx.shot('system-general-rows')
    },
  },
  {
    name: 'e4 login-item approval dialog',
    async run(ctx) {
      const login = fake()
      login.seed(DISABLED)
      login.seed({ supported: true, openAtLogin: true, status: 'requires-approval' }, true)
      // A General page left open by the shot before still shows that state; load it fresh.
      ctx.tabs.openInternal('atelier://settings/appearance')
      await ctx.chrome.until<boolean>(`return !document.querySelector('[data-settings-anchor="open-at-login"]')`, 5000, 'another settings page')
      await openGeneral(ctx)
      await ctx.chrome.until<boolean>(`return document.querySelector('[data-settings-anchor="open-at-login"] [role="switch"]')?.getAttribute('aria-checked') === 'false'`, 5000, 'the switch to read off')
      await sleep(200)
      await ctx.chrome.js(`document.querySelector('[data-settings-anchor="open-at-login"] [role="switch"]').click(); return true`)
      // The overlay host draws it above the page (the chrome only as a fallback).
      const doc = await docWith(ctx.chrome, '.sys-approval', 5000, 'the approval dialog')
      await sleep(400)
      await ctx.shot('system-login-item-approval')
      await doc.escape()
      await doc.until<boolean>(`return !document.querySelector('.sys-approval')`, 5000, 'the approval dialog to close')
      login.write(false)
    },
  },
]
