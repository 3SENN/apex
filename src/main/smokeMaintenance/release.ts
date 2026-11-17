/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EngineStatus } from '@shared/engine'
import { RELEASE } from '@shared/release'
import { assert } from '../smokeKit'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// The public-release flag (smoke check 12). A build with
// ATELIER_PUBLIC_RELEASE=1 offers only the API key: engines that need a
// provider's approval before a public release may offer them are left out
// (scripts/internal.mjs), so Settings › Model and key (and the welcome step,
// which reads the same status) has no engine choice and no other sign-in.
// scripts/release/smoke-packaged.mjs requires this check to pass in a public
// release; its name must match PUBLIC_FLAG_CHECK in scripts/release/checks.mjs.

export const PUBLIC_FLAG_CHECK = 'release: a public build offers only the API key engine'

export const checks: SmokeCheck[] = [
  {
    name: PUBLIC_FLAG_CHECK,
    async run({ chrome, tabs }) {
      const status = await chrome.invoke<EngineStatus>('engine', 'status')
      if (RELEASE.publicRelease) assert(status.engines.length === 1 && status.engines[0] === 'api-key' && status.others.length === 0, `engines.status offers ${status.engines.join(', ')} in a public build`)

      // The page shows no engine choice while the API key is the only engine.
      const before = tabs.activeId()
      tabs.openInternal('atelier://settings/model')
      const opened = tabs.activeId()
      try {
        await chrome.until(`return document.querySelector('.sp-page')`, 8000, 'Settings › Model and key')
        if (status.engines.length === 1) {
          await chrome.until(`return !document.querySelector('.mk-choices')`, 5000, 'the engine choice to stay hidden')
        }
      } finally {
        if (opened && opened !== before) tabs.close(opened)
        if (before && tabs.activeId() !== before) tabs.activate(before)
      }
    },
  },
]

export const shots: ShotSpec[] = []
