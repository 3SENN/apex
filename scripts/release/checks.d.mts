/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for checks.mjs, for the tests.

export interface FuseReading {
  name: string
  enabled: boolean
}

export const fuseName: (key: string) => string
export function expectedFuses(electronFuses: Record<string, unknown> | undefined): Record<string, boolean>
export function fusesFromWire(wire: Record<string, unknown>, names: Record<number, string>): FuseReading[]
export function fuseProblems(expected: Record<string, boolean>, actual: FuseReading[]): string[]

export const MAC_USAGE_KEYS: readonly string[]
export function plistProblems(plist: Record<string, any>, options: { assetCatalog: boolean }): string[]
export function entitlementProblems(entitlements: Record<string, unknown>, options: { mode: string; embeddedProfile: boolean; appId: string | null }): string[]
export function expectedResources(platform: string): { required: string[]; optional: Array<{ path: string; source: string }> }

export interface MacHelper {
  path: string
  helper: string
  usage: string[]
}
export const MAC_HELPERS: readonly MacHelper[]
export function infoPlistFromOtool(output: string): string | null
export function plistStrings(xml: string): Record<string, string>
export interface CodesignDetails {
  runtime: boolean
  team: string | null
  adhoc: boolean
}
export function codesignDetails(stderr: string): CodesignDetails
export function helperProblems(
  spec: MacHelper,
  options: { plist: string | null; bundleId: string; verify: { ok: boolean; error: string }; details: CodesignDetails; signed: boolean; appTeam: string | null },
): string[]

export const PUBLIC_FLAG_CHECK: string
export interface SmokeSummary {
  results: Map<string, boolean>
  failed: string[]
  passed: number
  total: number
}
export function smokeSummary(output: string): SmokeSummary
export function smokeProblems(summary: SmokeSummary, options: { exitCode: number | null; publicRelease: boolean }): string[]

export function ofVersion(names: string[], version: string): string[]
export const CHECKSUMMED: RegExp
export function checksumLines(files: Array<{ name: string; sha256: string }>): string
export const SUPPORT_MESSAGE_MAX: number
export function supportFeed(entries: Array<{ below?: unknown; message?: unknown }>): { schema: 1; unsupported: Array<{ below: string; message?: string }> }
export const UPLOADED: RegExp
export function uploadsFrom(names: string[]): string[]
export function refreshFeed(yml: string, changed: Array<{ name: string; sha512: string; size: number }>): string
