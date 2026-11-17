/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Whether this build includes the private internal/ folder (scripts/internal.mjs).
// The build sets __ATELIER_INTERNAL__; tests and tools without it get a build from
// public code only.

declare const __ATELIER_INTERNAL__: boolean | undefined

/** True when the private internal/ folder is built in. */
export const INTERNAL_BUILD: boolean = typeof __ATELIER_INTERNAL__ === 'boolean' ? __ATELIER_INTERNAL__ : false
