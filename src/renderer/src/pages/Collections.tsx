/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://history and apex://bookmarks moved to HistoryPage.tsx and BookmarksPage.tsx, and
// apex://downloads to DownloadsPage.tsx; the re-exports keep old imports working.
export { HistoryPage } from './HistoryPage'
export { BookmarksPage } from './BookmarksPage'
// Moved to pages/DownloadsPage.tsx; the re-export keeps old imports working
export { DownloadsPage } from './DownloadsPage'
