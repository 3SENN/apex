/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The clear-browsing-data choices (ST-36): the ⇧⌘⌫ dialog's form and
// Privacy's two one-click actions, as ClearDataRequests main runs.
import type { ClearDataRequest, ClearRange } from '@shared/services/settings'
import type { MessageKey } from '@shared/i18n/core'

export const CLEAR_RANGES: readonly ClearRange[] = ['hour', 'day', 'week', 'month', 'all']

export const CLEAR_RANGE_LABELS: Record<ClearRange, MessageKey> = {
  hour: 'settings.clearData.range.hour',
  day: 'settings.clearData.range.day',
  week: 'settings.clearData.range.week',
  month: 'settings.clearData.range.month',
  all: 'settings.clearData.range.all',
}

export type ClearKind = 'history' | 'siteData' | 'cache'
export const CLEAR_KINDS: readonly ClearKind[] = ['history', 'siteData', 'cache']

/** The dialog opens on the last hour with everything ticked, like most browsers. */
export function defaultClearRequest(range: ClearRange = 'hour'): ClearDataRequest {
  return { range, history: true, siteData: true, cache: true }
}

/** Privacy › Clear cache: every cache, cookies and sign-ins kept. */
export const CLEAR_CACHE: ClearDataRequest = { range: 'all', history: false, siteData: false, cache: true }

/** Privacy › Clear cookies and site data, for every site. */
export const CLEAR_SITE_DATA: ClearDataRequest = { range: 'all', history: false, siteData: true, cache: false }

/** Clear stays disabled until at least one kind is ticked. */
export function canClear(request: ClearDataRequest): boolean {
  return request.history || request.siteData || request.cache
}

/** Clearing history always asks once more (ST-36); the other kinds go at once. */
export function needsHistoryConfirm(request: ClearDataRequest): boolean {
  return request.history
}

/** Site data limited to a range only reaches sites visited in it, so the description says so. */
export function siteDataDescription(range: ClearRange): MessageKey {
  return range === 'all' ? 'settings.clearData.siteData.description' : 'settings.clearData.siteData.ranged'
}

export function toggleKind(request: ClearDataRequest, kind: ClearKind, on: boolean): ClearDataRequest {
  return { ...request, [kind]: on }
}
