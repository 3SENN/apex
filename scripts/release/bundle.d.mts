/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for bundle.mjs, for the tests.

export const DEFAULT_BUNDLE_ID: string
export function bundleIdFrom(env?: Record<string, string | undefined>): string
export function teamIdFrom(env?: Record<string, string | undefined>): string | null
export function requireTeamId(env?: Record<string, string | undefined>, what?: string): string
export function helperBundleId(bundleId: string, helper: string): string
export function withBundleIdentifier(plist: string, id: string): string
export function withProductName(plist: string, name: string): string
export function helperInfoPlist(sourcePlist: string, outDir: string, helper: string, env?: Record<string, string | undefined>): string
