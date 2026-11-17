/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { brandingAlias, brandingDefines } from './scripts/branding.mjs'
import { internalAlias, internalDefines, isInternal } from './scripts/internal.mjs'

// With the private internal/ folder, `@internal` is that folder and its own
// tests run too; without it, the public stubs (scripts/internal.mjs).
const internal = isInternal()

export default defineConfig({
  // The tests run with the branding a build would get (scripts/branding.mjs): run them with
  // ATELIER_OFFICIAL_BRANDING=0 and =1 to check both.
  resolve: { alias: { '@shared': resolve('src/shared'), ...internalAlias(), ...brandingAlias() } },
  define: { ...internalDefines(), ...brandingDefines() },
  test: {
    include: ['tests/**/*.test.ts', ...(internal ? ['internal/tests/**/*.test.ts'] : [])],
    environment: 'node',
  },
})
