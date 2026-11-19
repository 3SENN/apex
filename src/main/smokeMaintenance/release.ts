/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EngineStatus } from '@shared/engine'
import { RELEASE } from '@shared/release'
import { assert } from '../smokeKit'
import type { ShotSpec, SmokeCheck } from '../smokeBrowser/types'

// The public-release flag (smoke check 12). A build anyone may download
// (ATELIER_PUBLIC_RELEASE=1) has both engines: your Claude subscription
// (Claude Code on this computer) and your API key. A smoke run switches the
// Claude subscription off so it never touches a real Claude Code install
// (unless ATELIER_SMOKE_FAKE_CLAUDE=1 puts the stand-in behind it), so this
// checks that the engine is built in, that it is offered whenever it can run,
// and that Settings › Model and key shows the engine choice exactly then.
// scripts/release/smoke-packaged.mjs requires this check to pass in a public
// release; its name must match PUBLIC_FLAG_CHECK in scripts/release/checks.mjs.

export const PUBLIC_FLAG_CHECK = 'release: a public build offers your Claude subscription and the API key'

export const checks: SmokeCheck[] = [
  {
    name: PUBLIC_FLAG_CHECK,
    async run({ chrome, tabs }) {
      const status = await chrome.invoke<EngineStatus>('engine', 'status')
      assert(status.engines.includes('api-key'), `engines.status offers ${status.engines.join(', ')}, without the API key`)
      if (RELEASE.publicRelease) assert('claudeCode' in status && typeof status.claudeCodeAvailable === 'boolean', 'a public build has no Claude subscription engine')
      if (status.claudeCodeAvailable) assert(status.engines.includes('claude-code'), `engines.status offers ${status.engines.join(', ')} while the Claude subscription can run`)

      // The page shows the engine choice when there is more than one engine, and none otherwise.
      const before = tabs.activeId()
      tabs.openInternal('atelier://settings/model')
      const opened = tabs.activeId()
      try {
        await chrome.until(`return document.querySelector('.sp-page')`, 8000, 'Settings › Model and key')
        if (status.engines.length === 1) {
          await chrome.until(`return !document.querySelector('.mk-choices')`, 5000, 'the engine choice to stay hidden')
        } else {
          await chrome.until(`return document.querySelector('.mk-choices')`, 5000, 'the engine choice')
        }
      } finally {
        if (opened && opened !== before) tabs.close(opened)
        if (before && tabs.activeId() !== before) tabs.activate(before)
      }
    },
  },
]

export const shots: ShotSpec[] = []
