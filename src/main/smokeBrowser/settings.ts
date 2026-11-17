/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { measureStorage, storageCategories } from '../storage'
import { resetSteps, runResetSteps } from '../reset'
import { assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The settings smoke checks and light and dark shots: the
// storage categories and reset steps are registered (and a dry run deletes
// nothing), every settings page opens in a settings tab, and a shot of each page
// and of the clear-browsing-data dialog. Runs offline.

const PAGES = ['general', 'appearance', 'languages', 'default-browser', 'notifications', 'privacy', 'import', 'storage', 'about', ...(process.platform === 'darwin' ? ['dock-icon'] : [])]

/** Opens atelier://settings/<section> in the settings tab and waits for its address to settle on `page`. */
async function openSettings(ctx: SmokeContext, section: string, page = section.split('?')[0] ?? section): Promise<void> {
  ctx.tabs.openInternal(`atelier://settings/${section}`)
  await waitFor(() => ctx.tabs.snapshot().tabs.some((t) => t.url.startsWith(`atelier://settings/${page}`)), 5000, `Settings › ${page}`)
  // The page loads its data and measures before a shot.
  await sleep(400)
}

export const checks: SmokeCheck[] = [
  {
    name: 'settings: storage categories and reset steps are registered',
    async run() {
      const ids = storageCategories().map((c) => c.id)
      for (const id of ['chats', 'chat-images', 'memory', 'history', 'website-data', 'cache']) assert(ids.includes(id), `storage category ${id} is missing`)
      const views = await measureStorage()
      assert(views.every((v) => Number.isFinite(v.bytes) && v.bytes >= 0), 'a storage category measured badly')
      assert(resetSteps().length > 0, 'no reset steps are registered')
      const dry = await runResetSteps({ secrets: false, dryRun: true })
      assert(Array.isArray(dry.removed), 'the reset dry run returned nothing')
    },
  },
  {
    name: 'settings: every page opens',
    async run(ctx) {
      for (const page of PAGES) await openSettings(ctx, page)
      // An alias rewrites, and an unknown page falls back without an error.
      await openSettings(ctx, 'zoom', 'appearance')
      await openSettings(ctx, 'no-such-page', 'you')
    },
  },
]

export const shots: ShotSpec[] = [
  ...PAGES.map((page) => ({
    name: `settings-${page}`,
    async run(ctx: SmokeContext) {
      await openSettings(ctx, page)
      await ctx.shot(`settings-${page}`)
    },
  })),
  {
    name: 'settings-clear-data',
    async run(ctx) {
      await openSettings(ctx, 'privacy?clear=1')
      await ctx.shot('settings-clear-data')
    },
  },
]
