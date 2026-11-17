/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LibraryFileRef, ViewerTarget } from '@shared/files'

// Main-only Library Files API, for the agent turn: generated
// files from code execution, streamed reports and saved artifacts.

export interface LibraryFiles {
  addGenerated(input: { chatId: string; companionId: string; name: string; mediaType: string; bytes: Buffer }): LibraryFileRef
  /** A report the agent is still writing: state 'writing' until finishReport. `kind: 'artifact'` streams a save_artifact the same way. */
  beginReport(input: { chatId: string; companionId: string; name: string; mediaType: string; kind?: 'report' | 'artifact' }): LibraryFileRef
  finishReport(id: string, content: string | Buffer): LibraryFileRef
  fail(id: string, message: string): void
  listByChat(chatId: string): LibraryFileRef[]
  /** For Settings › Storage ('library-files'). */
  sizes(): { libraryFiles: number }
  /** save_artifact: stores the artifact in Library › Files. HTML and SVG open as artifact tabs. */
  saveArtifact(input: { chatId: string; companionId: string; title: string; format: 'markdown' | 'html' | 'svg' | 'csv' | 'json' | 'text'; content: string }): LibraryFileRef
  /** The report's text so far; open viewers update live while it is written. */
  updateReport(id: string, content: string | Buffer): LibraryFileRef
  get(id: string): LibraryFileRef | null
  /** The chat was deleted: its files stay in Library › Files with no chat. */
  forgetChat(chatId: string): void
  /** ON-13: the first artifact ever saved; fires once per install. Returns an unsubscribe. */
  onArtifactBuilt(fn: (file: LibraryFileRef) => void): () => void
}

/** What the viewer's delete hook hands Recently Deleted. */
export interface ViewerDeletion {
  name: string
  mediaType: string
  /** Where the file went (the Trash), or null when it was not a real file. */
  trashedPath: string | null
  target: unknown
}

export interface ViewerHooks {
  /** Recently Deleted listens here; returns an unsubscribe. */
  onDelete(fn: (deleted: ViewerDeletion) => void): () => void
  /** A file the person dropped or picked elsewhere (the composer, a drop on the window) may open in the viewer this session. */
  grantLocal(path: string): ViewerTarget | null
}
