/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for entitlements.mjs, for the tests.

export type SigningMode = 'unsigned' | 'developer-id' | 'developer-id-passkeys'
export type Entitlements = Record<string, boolean | string | string[]>

export interface ProfileFacts {
  name: string
  teamIds: string[]
  entitlements: Record<string, unknown>
  expires: string | null
  platforms: string[]
  allDevices: boolean
  devices: boolean
}

export interface MacSigning {
  mode: SigningMode
  bundleId: string
  /** APEX_TEAM_ID; null when it isn't set (only the passkeys mode requires it). */
  teamId: string | null
  entitlements: Entitlements
  mac: { notarize: boolean; hardenedRuntime?: boolean; entitlements?: string; provisioningProfile?: string }
}

export const BROWSER_PASSKEY_ENTITLEMENT: string
export const BASE_ENTITLEMENTS: string
export const INHERIT_ENTITLEMENTS: string
export const PASSKEY_ENTITLEMENTS: string
export function isRestricted(key: string): boolean
export function signingMode(env?: Record<string, string | undefined>): SigningMode
export function readEntitlements(xml: string): Entitlements
export function entitlementsXml(dict: Entitlements, comment?: string): string
export function webAuthnGroup(teamId: string, bundleId: string): string
export function entitlementsFor(mode: SigningMode, options: { base: Entitlements; teamId: string; bundleId: string; keychainGroup?: boolean }): Entitlements
export function profilePatternMatches(pattern: unknown, value: string): boolean
export function profileAllowsKeychainGroup(facts: ProfileFacts, group: string): boolean
export function profileProblems(facts: ProfileFacts, options: { teamId: string; bundleId: string; now?: Date }): string[]
export function decodeProfile(path: string, run?: unknown): ProfileFacts
export function preflightProfile(
  path: string,
  options: { teamId: string; bundleId: string; now?: Date; decode?: (path: string) => ProfileFacts },
): { facts: ProfileFacts; keychainGroup: boolean }
export function macSigningConfig(
  env?: Record<string, string | undefined>,
  options?: { repo?: string; out?: string; now?: Date; decode?: (path: string) => ProfileFacts; log?: (message: string) => void },
): MacSigning
