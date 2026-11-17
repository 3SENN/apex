/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Storage categories and reset steps. Each phase registers its
// own categories; Settings › Your data lists them in `order`.

export interface StorageCategoryView {
  id: string
  label: string
  order: number
  bytes: number
  /** The label of its clear action, when it has one. */
  clearLabel: string | null
}

/** The core categories; features register theirs (meeting-recordings, chat-attachments, library-files, activity-memory, workspace, search-index). */
export const CORE_STORAGE_CATEGORIES = ['chats', 'chat-images', 'memory', 'history', 'website-data', 'cache'] as const

export interface ResetStepView {
  id: string
  order: number
  label: string
  secrets: boolean
}

export interface ResetResult {
  removed: string[]
}
