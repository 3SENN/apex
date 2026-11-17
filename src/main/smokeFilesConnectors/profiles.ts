/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { session } from 'electron'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROFILES_SETTINGS_URL, profileDeleteBlock, profilePartition } from '@shared/profiles'
import { SettingsStore } from '../settings'
import { ProfileStore } from '../profiles/store'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// Profiles: Work (Moss) in its own partition, isolation, scopes, delete
// guard, the older settings migration. Offline only: temp folders, cookies
// set on 127.0.0.1 without a request, and no window of their own.

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message)
}

const temp = (): string => mkdtempSync(join(tmpdir(), 'atelier-smoke-c7-'))

export const checks: SmokeCheck[] = [
  {
    name: 'profiles: an A/B settings.json moves its profile keys into the default profile',
    async run() {
      const dir = temp()
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', searchEngine: 'duckduckgo', model: 'claude-sonnet-5-5', accent: 'plaid' }))
      const store = new SettingsStore(dir)
      const profile = JSON.parse(readFileSync(join(dir, 'profile-settings.json'), 'utf8')) as Record<string, unknown>
      assert(profile.theme === 'dark' && profile.searchEngine === 'duckduckgo', 'the profile keys did not move')
      assert(!('model' in profile), 'an app key landed in the profile file')
      assert(store.get().model === 'claude-sonnet-5-5' && store.get().accent === 'companion', 'values changed in the move')
    },
  },
  {
    name: 'profiles: Work (Moss) gets its own settings scope and partition, and the guards hold',
    async run() {
      const dir = temp()
      const profiles = new ProfileStore(dir)
      const settings = new SettingsStore(dir)
      const work = profiles.create({ name: 'Work', hue: 'moss' })
      settings.createProfile(work.id, { profileHue: 'moss' })
      assert(work.partition === profilePartition(work.id) && work.partition !== profilePartition('default'), 'Work shares a partition')
      settings.updateFor(work.id, { theme: 'dark', model: 'claude-haiku-5-5' })
      assert(settings.getFor(work.id).theme === 'dark' && settings.get().theme !== 'dark', 'a profile key leaked into the default profile')
      assert(settings.get().model === 'claude-haiku-5-5', 'an app key did not reach every profile')
      assert(profileDeleteBlock('default', profiles.list()) === 'default', 'the default profile could be deleted')
      assert(profileDeleteBlock(work.id, profiles.list()) === null, 'Work could not be deleted')
      assert(profileDeleteBlock(work.id, [work]) === 'last', 'the last profile could be deleted')
    },
  },
  {
    name: 'profiles: cookies stay inside their profile partition',
    async run() {
      const a = session.fromPartition(profilePartition(`smoke${Date.now().toString(36)}a`))
      const b = session.fromPartition(profilePartition(`smoke${Date.now().toString(36)}b`))
      try {
        await a.cookies.set({ url: 'http://127.0.0.1/', name: 'atelier-profile', value: 'work' })
        const own = await a.cookies.get({ name: 'atelier-profile' })
        const other = await b.cookies.get({ name: 'atelier-profile' })
        assert(own.length === 1, 'the cookie was not stored in its profile')
        assert(other.length === 0, 'a cookie crossed into another profile')
      } finally {
        await a.clearStorageData().catch(() => undefined)
        await b.clearStorageData().catch(() => undefined)
      }
    },
  },
]

// The live Settings page, as the person sees it with nothing added.
export const shots: ShotSpec[] = [
  {
    name: 'profiles-settings',
    async run(ctx) {
      // Settings is one tab: open the section in it, then wait for that section to draw.
      ctx.tabs.openInternal(PROFILES_SETTINGS_URL)
      await ctx.chrome.until(`return Boolean(document.querySelector('.pf-current'))`, 8000, 'the settings section')
      await new Promise((r) => setTimeout(r, 600))
      await ctx.shot('profiles-settings')
    },
  },
]
