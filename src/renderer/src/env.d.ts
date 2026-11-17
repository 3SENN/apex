/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />
import type { ApexApi } from '@shared/api'

declare global {
  interface Window {
    apex: ApexApi
  }

  // Electron.vite.config.ts; read them through RELEASE in src/shared/release.ts
  const __APEX_CHANNEL__: string | undefined
  const __APEX_PUBLIC_RELEASE__: string | undefined
  const __APEX_UPDATES__: string | undefined
  const __APEX_SUPPORT_EMAIL__: string | undefined
  const __APEX_WEBSITE__: string | undefined
  const __APEX_RELEASE_REPO__: string | undefined
  const __APEX_BUNDLE_ID__: string | undefined
  // scripts/internal.mjs; read it through INTERNAL_BUILD in src/shared/internal.ts
  const __APEX_INTERNAL__: boolean | undefined
  // scripts/branding.mjs; read it through BRANDING in src/shared/branding.ts
  const __APEX_BRANDING__: unknown
}

export {}
