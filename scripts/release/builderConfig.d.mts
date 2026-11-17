/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for builderConfig.mjs, for the tests.

import type { ProfileFacts } from './entitlements.mjs'
import type { SigningIdentity } from './identity.mjs'
import type { Branding } from '../branding.mjs'

export const OFFICIAL_DIR: string
export const OFFICIAL_NAME: string
export function brandedConfig(config: Record<string, any>, branding: Branding, repo?: string): Record<string, any>
/** The branding's trademark line with its name filled in, or '' when it claims none. */
export function brandTrademarkInfo(branding: Pick<Branding, 'shortName' | 'trademarkInfo'>): string

export function mergeConfig<T extends Record<string, any>>(base: T, ...sources: Array<Record<string, any> | undefined>): T
export function baseConfig(repo?: string): Record<string, any>
export function builderConfig(
  env?: Record<string, string | undefined>,
  options?: {
    platform?: string
    repo?: string
    out?: string
    identities?: SigningIdentity[] | (() => SigningIdentity[])
    decode?: (path: string) => ProfileFacts
    log?: (message: string) => void
  },
): Record<string, any>
export function withExtraResources<T extends Record<string, any>>(config: T, extra: Record<string, unknown[]> | undefined): T
