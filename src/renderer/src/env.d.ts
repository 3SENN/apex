/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

/// <reference types="vite/client" />
import type { AtelierApi } from '@shared/api'

declare global {
  interface Window {
    atelier: AtelierApi
  }

  // Electron.vite.config.ts; read them through RELEASE in src/shared/release.ts
  const __ATELIER_CHANNEL__: string | undefined
  const __ATELIER_PUBLIC_RELEASE__: string | undefined
  const __ATELIER_UPDATES__: string | undefined
  const __ATELIER_SUPPORT_EMAIL__: string | undefined
  const __ATELIER_WEBSITE__: string | undefined
  const __ATELIER_RELEASE_REPO__: string | undefined
  const __ATELIER_BUNDLE_ID__: string | undefined
  // scripts/branding.mjs; read it through BRANDING in src/shared/branding.ts
  const __ATELIER_BRANDING__: unknown
}

export {}
