/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, app, session, webContents, type WebContents } from 'electron'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPLE_PASSWORDS_EXTENSION_ID as ID, APPLE_PASSWORDS_HOST as HOST, type ApplePasswordsState } from '@shared/applePasswords'
import { CONTENT_COMPAT_FILE } from '../extensions/contentCompat'
import type { HostTab, HostWindow } from '../extensions/host'
import { findHost } from '../extensions/nativeMessaging'
import { currentExtensions, extensionsSmoke } from '../extensions/service'
import { sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'

// Apple's iCloud Passwords extension in Atelier, offline. The extension comes
// from a staged copy (ATELIER_SMOKE_ICLOUD_DIR: the Web Store package and its
// verified unpacked folder; Atelier never bundles it), and Apple's helper is
// replaced by a fake (tests/fixtures/extensions/native-host/
// password-helper-fake.mjs) registered in this run's own
// NativeMessagingHosts folder, the only one a smoke run reads. Checks: the
// background connects to the helper, the toolbar popup opens at its size
// and shows the pairing step, the content script answers in a sign-in page
// and its sign-in iframe, Atelier's password offers step aside, and the
// Settings card's switch installs through the verified Web Store path.

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

const staged = (): { unpacked: string; crx: string } | null => {
  const root = process.env.ATELIER_SMOKE_ICLOUD_DIR
  if (!root) return null
  const unpacked = join(root, 'unpacked')
  const crx = join(root, `${ID}.crx`)
  return existsSync(join(unpacked, 'manifest.json')) && existsSync(crx) ? { unpacked, crx } : null
}

const fixture = (name: string): string => join(process.env.ATELIER_SMOKE_FIXTURES ?? join(app.getAppPath(), 'tests/fixtures'), 'extensions', name)

function extensions() {
  const ext = currentExtensions()
  assert(ext, 'the extensions feature is not running')
  return ext
}

function scratchProfile(): { id: string; session: Electron.Session; console: string[] } {
  const id = `smokeicp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const s = session.fromPartition(`persist:atelier-smoke-${id}`)
  // The extension worker's console, so a failure says what the extension saw.
  const lines: string[] = []
  s.serviceWorkers.on('console-message', (_e: unknown, d: { message: string }) => {
    lines.push(d.message.slice(0, 300))
    if (lines.length > 40) lines.shift()
  })
  return { id, session: s, console: lines }
}

/** Waits, and on a timeout says what the extension's worker logged and what the helper got. */
async function waitOr(condition: () => boolean | Promise<boolean>, ms: number, what: string, profile: { console: string[] }, helper: FakeHelper | null): Promise<void> {
  try {
    await waitFor(condition, ms, what)
  } catch (err) {
    const log = helper ? JSON.stringify(helper.log().slice(-6)) : '–'
    throw new Error(`${err instanceof Error ? err.message : String(err)} Worker: ${profile.console.slice(-5).join(' | ') || '(nothing)'} Helper: ${log}`)
  }
}

interface FakeHelper {
  log(): Array<Record<string, unknown>>
  remove(): void
}

/** Registers the fake helper under Apple's host name in this run's own folder; checks the lookup finds it and nothing else. */
function installFakeHelper(): FakeHelper {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-smoke-helper-'))
  const logFile = join(dir, 'helper.log')
  const launcher = join(dir, 'PasswordHelperFake')
  const node = process.env.ATELIER_SMOKE_NODE ?? process.execPath
  // Hosts start without Electron's switches, so the launcher asks for plain Node itself.
  writeFileSync(launcher, `#!/bin/sh\nexport ATELIER_FAKE_HELPER_LOG="${logFile}"\nexport ELECTRON_RUN_AS_NODE=1\nexec "${node}" "${fixture('native-host/password-helper-fake.mjs')}" "$@"\n`)
  chmodSync(launcher, 0o755)
  const hosts = join(app.getPath('userData'), 'NativeMessagingHosts')
  mkdirSync(hosts, { recursive: true })
  const manifest = join(hosts, `${HOST}.json`)
  writeFileSync(manifest, JSON.stringify({ name: HOST, description: 'Smoke stand-in for a password helper', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }))
  const found = findHost(HOST, ID, [hosts])
  assert(found.ok && found.host.path === launcher, 'the fake helper is not what the host lookup finds')
  return {
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [],
    remove: () => {
      rmSync(manifest, { force: true })
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A sign-in page with its sign-in form in a cross-origin iframe (127.0.0.1 hosts localhost). */
function servePages(ctx: SmokeContext): { page: string } {
  const port = new URL(ctx.server.http).port
  ctx.server.page(
    '/icloud/frame',
    `<!doctype html><title>Sign in frame</title><form><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>`,
  )
  ctx.server.page(
    '/icloud/login',
    `<!doctype html><title>Sign in</title><h1>Shop</h1><form><input name="email" autocomplete="username"><input type="password" name="pw" autocomplete="current-password"><button>Sign in</button></form><iframe src="http://localhost:${port}/icloud/frame" width="400" height="200"></iframe>`,
  )
  return { page: `${ctx.server.http}/icloud/login` }
}

/** A window of the smoke profile for the popup to hang in: the app's own window, with the sign-in page as its tab. */
function smokeWindow(profileId: string, page: WebContents): HostWindow {
  const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? BrowserWindow.getAllWindows()[0]
  assert(main, 'no window to anchor the popup in')
  const tab = (): HostTab => ({ id: page.id, windowId: 99_001, index: 0, url: page.getURL(), title: page.getTitle(), active: true, pinned: false, audible: false, muted: false, loading: page.isLoading(), favicon: null })
  return { id: 99_001, profileId, focused: true, window: main, chrome: main.webContents, tabs: () => (page.isDestroyed() ? [] : [tab()]) }
}

const popupContents = (): WebContents | undefined => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().startsWith(`chrome-extension://${ID}/page_popup.html`))

/** Opens the toolbar popup and waits for its pairing step (the 6-digit code boxes). Returns the popup. */
async function popupAtPairing(profileId: string, win: HostWindow): Promise<WebContents> {
  const { host } = extensions()
  host.runAction(profileId, ID, win, { x: 700, y: 4, width: 32, height: 32 })
  let popup: WebContents | undefined
  await waitFor(() => !!(popup = popupContents()), 10_000, 'the toolbar popup')
  assert(popup, 'no popup')
  const lines: string[] = []
  popup.on('console-message', (e: { message?: string }) => void lines.push(String(e.message ?? '').slice(0, 200)))
  const shown = `(() => { const pin = document.getElementById('divPIN'); return !!pin && getComputedStyle(pin).display !== 'none' && document.querySelectorAll('input.PIN').length === 6 })()`
  const visible = `[...document.querySelectorAll('body > div')].filter((d) => getComputedStyle(d).display !== 'none').map((d) => d.id).join(',')`
  await waitFor(async () => (await popup!.executeJavaScript(shown).catch(() => false)) === true, 15_000, 'the popup’s 6-digit code step').catch(async (err: unknown) => {
    const showing = popup!.isDestroyed() ? 'closed' : String(await popup!.executeJavaScript(visible).catch(() => '?'))
    throw new Error(`${err instanceof Error ? err.message : String(err)} The popup shows: ${showing}. Its console: ${lines.slice(-4).join(' | ') || '(nothing)'}`)
  })
  return popup
}

let checkedOnce = false
const skip = (): boolean => {
  if (staged()) return false
  if (!checkedOnce) console.log('note  icloud passwords: ATELIER_SMOKE_ICLOUD_DIR is unset or empty, so the iCloud Passwords checks have nothing to load')
  checkedOnce = true
  return true
}

export const checks: SmokeCheck[] = [
  {
    name: 'icloud passwords: the staged extension connects to the helper, its popup shows pairing, its content script runs in the sign-in iframe, Atelier steps aside',
    async run(ctx) {
      if (skip()) return
      const files = staged()!
      const { host, apple } = extensions()
      const helper = installFakeHelper()
      const profile = scratchProfile()
      host.attach(profile.session, profile.id)
      const page = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: profile.session, sandbox: true, contextIsolation: true } })
      try {
        // The person answered "Always" already (the Settings switch does this): no prompt in the smoke window.
        host.allowNativeHost(profile.id, ID, HOST)
        const id = await host.loadUnpacked(profile.id, files.unpacked)
        assert(id === ID, `the package key gave ${id}, not the Web Store id`)
        const item = host.list(profile.id).find((e) => e.id === ID)
        assert(item?.supported && item.enabled && host.isLoaded(profile.id, ID), `the extension did not run: ${item?.unsupportedReason ?? 'not listed'}`)

        // The background reaches the helper, started the way Chrome starts it, and gets its hello answered.
        await waitOr(() => !!host.nativeState(profile.id, ID, HOST)?.replied, 20_000, 'the helper to answer the background.', profile, helper)
        const started = helper.log().find((l) => l.started) as { args?: string[] } | undefined
        assert(started?.args?.[0] === `chrome-extension://${ID}/` && started.args[1] === '--parent-window=0', `the helper was started with ${JSON.stringify(started?.args)}`)
        assert(helper.log().some((l) => l.cmd === 14), 'the background never said hello to the helper')
        // It turned the browser's password saving off through chrome.privacy (its settings live in storage.sync).
        await waitOr(() => host.passwordSavingHeldOff(profile.id)?.extensionId === ID, 10_000, 'the extension to take over password saving.', profile, helper)
        assert(apple.status(profile.id).atelierStepsAside, 'Atelier’s own password offers did not step aside')

        // A sign-in page whose form is also in a cross-origin iframe.
        const { page: url } = servePages(ctx)
        await page.loadURL(url)
        host.watchContents(profile.id, page.webContents)

        // The toolbar popup opens at the size its page asks for and reaches the code step.
        const win = smokeWindow(profile.id, page.webContents)
        const popup = await popupAtPairing(profile.id, win)
        const view = win.window.contentView.children.find((v) => (v as Electron.WebContentsView).webContents?.id === popup.id)
        const bounds = view?.getBounds()
        assert(bounds && bounds.width >= 300 && bounds.height >= 80, `the popup is ${JSON.stringify(bounds)}`)
        await waitFor(() => helper.log().some((l) => l.cmd === 2 && l.qid === 'm0'), 5000, 'the pairing challenge to reach the helper')
        await waitFor(() => apple.status(profile.id).state === 'waiting-for-code', 5000, 'the card to say it waits for the code')

        // From the extension's own page: its frames (webNavigation) and its content script in each one.
        const probe = `(async () => {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: ${page.webContents.id} })
          const out = []
          for (const f of frames) {
            try {
              const r = await chrome.tabs.sendMessage(${page.webContents.id}, { subject: 'isCompletionListVisible' }, { frameId: f.frameId })
              out.push({ frameId: f.frameId, parent: f.parentFrameId, url: f.url, answered: !!r && r.subject === 'isCompletionListVisible' })
            } catch (e) {
              out.push({ frameId: f.frameId, url: f.url, answered: false, error: String(e && e.message || e) })
            }
          }
          return JSON.stringify(out)
        })()`
        let frames: Array<{ frameId: number; parent?: number; url: string; answered: boolean; error?: string }> = []
        await waitFor(
          async () => {
            frames = JSON.parse(String(await popup.executeJavaScript(probe).catch(() => '[]'))) as typeof frames
            return frames.length >= 2 && frames.every((f) => f.answered)
          },
          15_000,
          'the content script in the page and its sign-in iframe',
        ).catch(() => {
          throw new Error(`content scripts answered: ${JSON.stringify(frames)}`)
        })
        const iframe = frames.find((f) => f.url.includes('/icloud/frame'))
        assert(iframe && iframe.frameId !== 0 && iframe.parent === 0, `the sign-in iframe is ${JSON.stringify(iframe)}`)
      } finally {
        if (!page.isDestroyed()) page.destroy()
        await host.detach(profile.id)
        helper.remove()
      }
    },
  },
  {
    name: 'icloud passwords: the Settings switch installs the package through the verified Web Store path with one confirmation, then turns it off',
    async run(ctx) {
      if (skip()) return
      const files = staged()!
      const { host, apple, services } = extensions()
      const profile = scratchProfile()
      host.attach(profile.session, profile.id)
      const prompts: string[] = []
      const page = new BrowserWindow({ show: false, webPreferences: { session: profile.session, sandbox: true, contextIsolation: true } })
      let helper: FakeHelper | null = null
      try {
        const wait = async (state: ApplePasswordsState, what: string): Promise<void> =>
          waitOr(() => apple.status(profile.id).state === state, 20_000, `${what}.`, profile, helper).catch((err: unknown) => {
            throw new Error(`The card says ${apple.status(profile.id).state}. ${err instanceof Error ? err.message : String(err)}`)
          })
        assert(apple.status(profile.id).state === 'helper-missing', `without a helper the card says ${apple.status(profile.id).state}`)
        helper = installFakeHelper()
        assert(apple.status(profile.id).state === 'off', `with the helper but no extension the card says ${apple.status(profile.id).state}`)

        extensionsSmoke.fetchAppleCrx = async () => readFileSync(files.crx)
        extensionsSmoke.installPrompt = (prompt) => {
          prompts.push(prompt.name)
          services.extensions.respondInstall(prompt.id, true)
        }
        const { page: url } = servePages(ctx)
        await page.loadURL(url)
        const win = smokeWindow(profile.id, page.webContents)
        extensionsSmoke.openApplePopup = (p) => host.runAction(p, ID, win, { x: 700, y: 4, width: 32, height: 32 })

        await apple.setOn(profile.id, true)
        assert(prompts.length === 1 && /iCloud/i.test(prompts[0] ?? ''), `the install asked ${prompts.length} times (${prompts.join(', ')})`)
        const item = host.list(profile.id).find((e) => e.id === ID)
        assert(item?.source === 'store' && item.enabled && item.pinned, 'the store install is not on and pinned')
        // Atelier's copy of a store package carries the content-script prelude (chrome.storage.sync for content scripts).
        const copy = host.dirOf(profile.id, ID)
        assert(copy, 'the store install has no folder')
        const m = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8')) as { content_scripts?: Array<{ js?: string[] }> }
        assert(m.content_scripts?.length && m.content_scripts.every((e) => e.js?.[0] === CONTENT_COMPAT_FILE), 'the store copy lacks the content-script prelude')
        await wait('waiting-for-code', 'the popup the switch opened to reach the code step')
        assert(apple.status(profile.id).atelierStepsAside, 'Atelier did not step aside after the switch')

        await apple.setOn(profile.id, false)
        await sleep(100)
        const off = apple.status(profile.id)
        assert(off.state === 'off' && !off.enabled && !off.atelierStepsAside, `turning it off left ${JSON.stringify(off)}`)
      } finally {
        extensionsSmoke.fetchAppleCrx = null
        extensionsSmoke.installPrompt = null
        extensionsSmoke.openApplePopup = null
        if (!page.isDestroyed()) page.destroy()
        await host.detach(profile.id)
        helper?.remove()
      }
    },
  },
]

export const shots: ShotSpec[] = []
