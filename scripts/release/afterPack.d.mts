/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for afterPack.mjs, for the tests.

export const ICON_NAME: string
export function compileIcon(iconDir: string, outDir: string, iconName?: string): string
export function iconComposer(branding: import('../branding.mjs').Branding): { dir: string; name: string } | null
export function helperName(name: string, productName: string): string
export function nameHelpers(app: string, productName: string): number
export default function afterPack(context: unknown): Promise<void>
