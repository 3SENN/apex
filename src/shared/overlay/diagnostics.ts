/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The diagnostics overlay surfaces: the problem report (OV-30, a
// window-anchored modal that blurs the whole window) and the crash notice.
export const DIAGNOSTICS_SURFACES = ['problem-report', 'crash-notice'] as const

export type DiagnosticsSurfaceId = (typeof DIAGNOSTICS_SURFACES)[number]

export interface DiagnosticsSurfaceProps {
  /** The dialog opens with the chat that is showing (if any) and the crash dumps preselected from the crash notice. */
  'problem-report': { chatId: string | null; chatTitle: string | null; tabId: string | null; preselectCrashDumps: boolean }
  'crash-notice': { dumps: number; crashReportsOn: boolean }
}
