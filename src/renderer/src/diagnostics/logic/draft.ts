/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  REPORT_FILES_MAX_BYTES,
  REPORT_IMAGE_MAX_BYTES,
  REPORT_MAX_FILES,
  REPORT_MAX_IMAGES,
  type PickedReportFile,
  type ReportDraft,
} from '@shared/diagnostics'

// The problem report's form state (OV-30), kept pure so it can be tested:
// adding pasted images and picked files within their limits, what counts
// as unsaved work, and the draft main receives.

export interface DraftImage {
  id: string
  name: string
  dataUrl: string
  bytes: number
}

export interface DraftState {
  description: string
  images: DraftImage[]
  files: PickedReportFile[]
  includeChat: boolean
  includeScreenshot: boolean
  includeCrash: boolean
}

/** Where the dialog was opened from: what it may offer to include. */
export interface DraftContext {
  chatId: string | null
  tabId: string | null
}

export type AddProblem = { kind: 'too-many-images' } | { kind: 'image-too-large'; name: string } | { kind: 'too-many-files' } | { kind: 'files-too-large' }

export function initialDraft(preselectCrashDumps: boolean): DraftState {
  // Page text, chats and crash dumps can be personal: each is opt-in.
  return { description: '', images: [], files: [], includeChat: false, includeScreenshot: false, includeCrash: preselectCrashDumps }
}

/** The decoded size of a base64 data URL. */
export function dataUrlSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

/** Adds images up to the count limit, refusing any over the size limit. */
export function addImages(current: readonly DraftImage[], incoming: readonly DraftImage[]): { images: DraftImage[]; problems: AddProblem[] } {
  const images = [...current]
  const problems: AddProblem[] = []
  for (const image of incoming) {
    if (image.bytes > REPORT_IMAGE_MAX_BYTES) {
      problems.push({ kind: 'image-too-large', name: image.name })
      continue
    }
    if (images.length >= REPORT_MAX_IMAGES) {
      if (!problems.some((p) => p.kind === 'too-many-images')) problems.push({ kind: 'too-many-images' })
      continue
    }
    images.push(image)
  }
  return { images, problems }
}

/** Adds picked files up to the count and total-size limits; a file picked twice counts once. */
export function addFiles(current: readonly PickedReportFile[], incoming: readonly PickedReportFile[]): { files: PickedReportFile[]; problems: AddProblem[] } {
  const files = [...current]
  const problems: AddProblem[] = []
  let total = files.reduce((sum, f) => sum + f.bytes, 0)
  for (const file of incoming) {
    if (files.some((f) => f.token === file.token)) continue
    if (files.length >= REPORT_MAX_FILES) {
      if (!problems.some((p) => p.kind === 'too-many-files')) problems.push({ kind: 'too-many-files' })
      continue
    }
    if (total + file.bytes > REPORT_FILES_MAX_BYTES) {
      if (!problems.some((p) => p.kind === 'files-too-large')) problems.push({ kind: 'files-too-large' })
      continue
    }
    files.push(file)
    total += file.bytes
  }
  return { files, problems }
}

/** Something would be lost by closing: text, images or files. */
export function isDirty(state: DraftState): boolean {
  return state.description.trim().length > 0 || state.images.length > 0 || state.files.length > 0
}

/** What main receives. Switches that don't apply here (no chat shown, no web tab) send nothing. */
export function toReportDraft(state: DraftState, context: DraftContext, options: { withImages?: boolean; crashAvailable?: boolean } = {}): ReportDraft {
  return {
    description: state.description,
    images: options.withImages === false ? [] : state.images.map((i) => ({ name: i.name, dataUrl: i.dataUrl })),
    fileTokens: state.files.map((f) => f.token),
    includeChatId: state.includeChat && context.chatId ? context.chatId : null,
    includeScreenshotTabId: state.includeScreenshot && context.tabId ? context.tabId : null,
    includeCrashDumps: state.includeCrash && options.crashAvailable !== false,
  }
}

export type SaveBlock = 'description' | 'too-large' | null

/** Why saving is not possible right now, if it isn't. */
export function saveBlock(state: DraftState, overLimit: boolean): SaveBlock {
  if (!state.description.trim()) return 'description'
  if (overLimit) return 'too-large'
  return null
}

/** ⌘↩ on macOS, Ctrl+Enter elsewhere. */
export function isSaveAndEmailKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): boolean {
  return e.key === 'Enter' && !e.altKey && !e.shiftKey && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
}

/** The file name without its folder, for the success state. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
