/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Build-time defines for main and preload, set by electron.vite.config.ts
// from scripts/release/config.mjs. Each may be absent (tests, older builds), so
// read them through `typeof`, or better, through RELEASE in src/shared/release.ts.

/** 'dev', 'beta' or 'stable'. */
declare const __ATELIER_CHANNEL__: string | undefined
/** '1' for a public release (the API key is then the only engine; scripts/internal.mjs). */
declare const __ATELIER_PUBLIC_RELEASE__: string | undefined
/** '1' only with a publish target and a signing identity. */
declare const __ATELIER_UPDATES__: string | undefined
declare const __ATELIER_SUPPORT_EMAIL__: string | undefined
declare const __ATELIER_WEBSITE__: string | undefined
/** 'owner/name', or '' for none. */
declare const __ATELIER_RELEASE_REPO__: string | undefined
/** The app id (ATELIER_BUNDLE_ID, else com.sennechin.atelier; scripts/release/bundle.mjs). */
declare const __ATELIER_BUNDLE_ID__: string | undefined
/** True when the private internal/ folder is built in (scripts/internal.mjs); read it through INTERNAL_BUILD in src/shared/internal.ts. */
declare const __ATELIER_INTERNAL__: boolean | undefined
/** The branding (scripts/branding.mjs); read it through BRANDING in src/shared/branding.ts. */
declare const __ATELIER_BRANDING__: unknown
