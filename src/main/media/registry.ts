/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PageMediaReport } from '@shared/media'

// Where other main modules find the media hub's reports (automatic
// picture-in-picture, pip.ts) without importing the hub itself.

type ReportSource = (tabId: string) => PageMediaReport | null

let source: ReportSource | null = null

export function setMediaReports(fn: ReportSource | null): void {
  source = fn
}

/** The page helper's report for the tab's lead frame, or null (no hub yet, or no media there). */
export function mediaReportOf(tabId: string): PageMediaReport | null {
  return source?.(tabId) ?? null
}
