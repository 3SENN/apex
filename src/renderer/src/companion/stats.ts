/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Test hook for the smoke test: how many companions drew a first 3D frame,
// and every load or render error seen.

export interface CompanionStats {
  ready: number
  errors: string[]
}

declare global {
  interface Window {
    __apexCompanionStats?: CompanionStats
  }
}

const MAX_ERRORS = 50

function stats(): CompanionStats {
  if (typeof window === 'undefined') return { ready: 0, errors: [] }
  window.__apexCompanionStats ??= { ready: 0, errors: [] }
  return window.__apexCompanionStats
}

export function initCompanionStats(): void {
  stats()
}

export function reportCompanionReady(): void {
  stats().ready += 1
}

export function reportCompanionError(message: string): void {
  const { errors } = stats()
  // Every instance hits the same failure; log and keep it once.
  if (errors.includes(message) || errors.length >= MAX_ERRORS) return
  errors.push(message)
  console.warn(`[companion] ${message}`)
}
