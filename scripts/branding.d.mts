/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for branding.mjs, so electron.vite.config.ts, vitest.config.ts, the build scripts and the tests stay checked.

export type Env = Record<string, string | undefined>
export type BrandingId = 'official' | 'unofficial'

/** branding/<id>/branding.json. */
export interface BrandingJson {
  name: string
  shortName: string
  bundleId: string
  /** Who publishes the build: the installer's publisher and Windows' company name. */
  publisher: string
  /** The copyright line (macOS Info.plist, Windows file properties, Settings › About). */
  copyright: string
  /** The trademark line Settings › About shows, with {brand} for the name; "" for none. */
  trademarkInfo: string
  defaultPreset: string
  /** The branding's own default companion (a preset file in the folder), or null for one from presets.json. */
  companion?: string | null
  hiddenPresets: string[]
  icons: {
    mac: string
    macIconComposer: string | null
    win: string
    png: string
    linux: string
    documents: { html: string; companion: string; pack: string }
    dmgBackground: string
    installerSidebar: string
    resources: string
  }
  logo: string | null
}

export interface Branding extends BrandingJson {
  id: BrandingId
  official: boolean
  /** The branding's folder (absolute). */
  dir: string
}

/** The __APEX_BRANDING__ define's value (src/shared/branding.ts reads it). */
export interface RuntimeBranding {
  id: BrandingId
  official: boolean
  name: string
  shortName: string
  bundleId: string
  copyright: string
  trademarkInfo: string
  companion: { id: string; name: string; look: unknown }
  /** The branding's own default companion as a whole preset (companion.json), or null. */
  ownPreset: Record<string, unknown> | null
  hiddenPresets: string[]
  wordmark: boolean
}

export const REPO: string
export const BRANDINGS: readonly BrandingId[]
export const PRESETS: string
export function officialBranding(env?: Env, repo?: string): boolean
export function brandingId(env?: Env, repo?: string): BrandingId
export function brandingRoot(env?: Env, repo?: string): string
export function brandingProblems(json: unknown): string[]
export function readBranding(id: string, repo?: string): Branding
export function loadBranding(env?: Env, repo?: string): Branding
export function brandingFile(branding: Branding, file: string, repo?: string): string
export function companionProblems(json: unknown, defaultPreset: string): string[]
export function ownCompanion(branding: Branding): Record<string, unknown> | null
export function brandingCompanion(branding: Branding, repo?: string): RuntimeBranding['companion']
export function runtimeBranding(env?: Env, repo?: string): RuntimeBranding
export function brandingDefines(env?: Env, repo?: string): { __APEX_BRANDING__: string }
export function brandingAlias(env?: Env, repo?: string): { '@branding': string }
export function describeBranding(env?: Env, repo?: string): string
export function missingBrandingFiles(branding: Branding): string[]
