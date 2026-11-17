/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The page channel besides PAGE.dialog: the page preload reports
// the page's own cross-document navigations over sendSync, before
// beforeunload runs, so "Leave this page?" can redo them.
export const PAGE_LEAVE_INTENT = 'atelier-page:leave-intent'

export interface PageLeaveIntentMessage {
  url: string
  /** A form submission (a post can't be replayed). */
  form: boolean
}
