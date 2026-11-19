/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { brandingAlias, brandingDefines } from './scripts/branding.mjs'

export default defineConfig({
  // The tests run with the branding a build would get (scripts/branding.mjs): run them with
  // ATELIER_OFFICIAL_BRANDING=0 and =1 to check both.
  resolve: { alias: { '@shared': resolve('src/shared'), '@engines': resolve('src/engines'), ...brandingAlias() } },
  define: { ...brandingDefines() },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
