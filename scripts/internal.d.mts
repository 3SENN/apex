/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for internal.mjs, so the release scripts and the tests stay checked.

export type Env = Record<string, string | undefined>

export const REPO: string
export const INTERNAL_MARKER: string
export function internalPresent(repo?: string): boolean
export function isInternal(env?: Env, repo?: string): boolean
export function internalBuild(env?: Env, repo?: string): { prepackage: string[]; extraResources: Record<string, unknown[]> }
export function runPrepackage(env?: Env, repo?: string): number
export function describeMode(env?: Env, repo?: string): string
