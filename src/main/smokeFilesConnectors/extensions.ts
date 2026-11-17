/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, session } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSIONS_SETTINGS_URL } from '@shared/extensions'
import { currentExtensions } from '../extensions/service'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Extensions: the unpacked fixture MV3 extension in a real profile session
// (Electron's own session.extensions behind the adapter): listing, compat
// notice, command clash, pin, turn off and on, revoke, remove.
// Offline only: fixtures from tests/fixtures/extensions, a throwaway
// persistent partition, no Web Store and no update checks.

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

// A packaged run has no tests/ inside its asar: smoke-packaged.mjs points APEX_SMOKE_FIXTURES at the repo's.
const fixture = (name: string): string => join(process.env.APEX_SMOKE_FIXTURES ?? join(app.getAppPath(), 'tests/fixtures'), 'extensions', name)

/** A fresh profile id and persistent session for one check (extensions refuse in-memory sessions). */
function scratchProfile(): { id: string; session: Electron.Session } {
  const id = `smokeext${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return { id, session: session.fromPartition(`persist:apex-smoke-${id}`) }
}

function extensions() {
  const ext = currentExtensions()
  assert(ext, 'the extensions feature is not running')
  return ext
}

export const checks: SmokeCheck[] = [
  {
    name: 'extensions: the MV3 fixture loads in a profile session with its plain-words permissions and command clash',
    async run() {
      const { host } = extensions()
      const profile = scratchProfile()
      host.attach(profile.session, profile.id)
      try {
        const id = await host.loadUnpacked(profile.id, fixture('mv3-basic'))
        assert(host.isLoaded(profile.id, id), 'Electron did not load the fixture')
        const item = host.list(profile.id).find((e) => e.id === id)
        assert(item, 'the fixture is not listed')
        assert(item.supported && item.enabled && item.hasPopup, 'the fixture is not a runnable extension with a popup')
        assert(item.permissions[0]?.label === 'Read and change your data on example.com', 'site access is not the first plain-words line')
        assert(item.optional.length === 3 && item.optional.every((p) => !p.granted), 'optional permissions are wrong')
        assert(item.commands.some((c) => c.clash === 'new-private-window'), 'the clashing command does not show its clash')
        assert(item.icon?.startsWith('data:image/png'), 'the icon did not load')
      } finally {
        await host.detach(profile.id)
      }
    },
  },
  {
    name: 'extensions: pin, turn off and on, then remove clears the extension',
    async run() {
      const { host } = extensions()
      const profile = scratchProfile()
      host.attach(profile.session, profile.id)
      try {
        const id = await host.loadUnpacked(profile.id, fixture('mv3-basic'))
        host.pin(profile.id, id, true)
        assert(host.list(profile.id)[0]?.pinned, 'pinning did not stick')
        await host.setEnabled(profile.id, id, false)
        assert(!host.isLoaded(profile.id, id), 'turning it off left it loaded')
        await host.setEnabled(profile.id, id, true)
        assert(host.isLoaded(profile.id, id), 'turning it on did not load it')
        await host.remove(profile.id, id)
        assert(!host.isLoaded(profile.id, id) && host.list(profile.id).length === 0, 'remove left it behind')
        // The developer's unpacked folder is theirs: it stays.
        assert(existsSync(join(fixture('mv3-basic'), 'manifest.json')), 'remove deleted an unpacked folder')
      } finally {
        await host.detach(profile.id)
      }
    },
  },
  {
    name: 'extensions: an MV2 extension is listed with the notice and never runs',
    async run() {
      const { host } = extensions()
      const profile = scratchProfile()
      host.attach(profile.session, profile.id)
      try {
        const id = await host.loadUnpacked(profile.id, fixture('mv2-legacy'))
        const item = host.list(profile.id).find((e) => e.id === id)
        assert(item && !item.supported && /Manifest V2/.test(item.unsupportedReason ?? ''), 'the MV2 notice is missing')
        assert(!host.isLoaded(profile.id, id), 'an unsupported extension was loaded')
      } finally {
        await host.detach(profile.id)
      }
    },
  },
]

// The live Settings page, as the person sees it with nothing added.
export const shots: ShotSpec[] = [
  {
    name: 'extensions-settings',
    async run(ctx) {
      // Settings is one tab: open the section in it, then wait for that section to draw.
      ctx.tabs.openInternal(EXTENSIONS_SETTINGS_URL)
      await ctx.chrome.until(`return Boolean(document.querySelector('.sp-page')?.textContent.includes('Installed'))`, 8000, 'the settings section')
      await new Promise((r) => setTimeout(r, 600))
      await ctx.shot('extensions-settings')
    },
  },
]
