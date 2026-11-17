/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The extensions part of Settings › Import and the welcome step (ST-46 X):
// which extensions start ticked, toggling, and how the report reads. Pure,
// so tested.
import { pickableExtension, type ExtensionImportReport, type ExtensionSkipReason, type ImportableExtension } from '@shared/browserImport'
import type { MessageKey } from '@shared/i18n/core'

export const EXTENSION_SKIP_LABELS: Record<ExtensionSkipReason, MessageKey> = {
  notOnStore: 'extImport.skip.notOnStore',
  unsupported: 'extImport.skip.unsupported',
  installed: 'extImport.skip.installed',
  declined: 'extImport.skip.declined',
  failed: 'extImport.skip.failed',
}

/** Live "already here" on top of what main said when the list was read (the page follows installs as they land). */
export function withInstalled(list: readonly ImportableExtension[], installedIds: ReadonlySet<string>): ImportableExtension[] {
  return list.map((e) => (e.installed || !installedIds.has(e.id) ? e : { ...e, installed: true }))
}

/** Ticks or unticks one, keeping the list's order and only what can be picked. */
export function togglePick(picks: readonly string[], id: string, on: boolean, list: readonly ImportableExtension[]): string[] {
  const next = new Set(picks)
  if (on) next.add(id)
  else next.delete(id)
  return list.filter((e) => next.has(e.id) && pickableExtension(e)).map((e) => e.id)
}

/** Every one that can be picked. */
export function allPicks(list: readonly ImportableExtension[]): string[] {
  return list.filter(pickableExtension).map((e) => e.id)
}

/** Picks still valid after the list changed (something got installed meanwhile). */
export function keepPicks(picks: readonly string[], list: readonly ImportableExtension[]): string[] {
  return togglePick(picks, '', false, list)
}

/** The report's headline: cancelled, some added, or none added. */
export function reportHeadline(report: ExtensionImportReport): 'cancelled' | 'added' | 'none' {
  if (report.cancelled) return 'cancelled'
  return report.added.length > 0 ? 'added' : 'none'
}

/** Tone for the report: success when nothing was left out but "already in Atelier", a warning otherwise. */
export function reportTone(report: ExtensionImportReport): 'success' | 'warning' | 'info' {
  if (report.cancelled) return 'info'
  const real = report.skipped.filter((s) => s.reason !== 'installed')
  if (real.length > 0) return 'warning'
  return report.added.length > 0 ? 'success' : 'info'
}
