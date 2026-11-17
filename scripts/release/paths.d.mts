/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for paths.mjs, for the tests.

export interface PackagedApp {
  app: string
  executable: string
  resources: string
}

export const REPO: string
export const DIST: string
export function packageJson(): { name: string; version: string; [key: string]: unknown }
type Where = { dist?: string; platform?: string; arch?: string; productName?: string }
export function packagedApp(where?: Where): PackagedApp | null
export function packagedApps(where?: Where): Array<PackagedApp & { arch: string }>
