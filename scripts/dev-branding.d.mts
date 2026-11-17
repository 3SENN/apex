/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for dev-branding.mjs, for the tests.

export const APP_NAME: string
export function plistString(text: string, key: string): string | null
export function setPlistString(text: string, key: string, value: string): string
export function brandInfoPlist(text: string, name?: string): string
export function brandHelperPlist(text: string, name?: string, others?: string[]): string
export function brandDevApp(options?: { repo?: string; platform?: string; refresh?: (bundle: string) => unknown; branding?: import('./branding.mjs').Branding; others?: string[] }): { changed: string[]; skipped?: string }
