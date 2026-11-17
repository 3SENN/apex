/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isLongPaste } from '@shared/attachments'

// Pure rules for what a paste into the composer becomes (CH-24):
// files and clipboard images become attachments, long text becomes a paste
// chip, and anything else types as usual.

export interface PasteInput {
  /** The clipboard's plain text. */
  text: string
  /** Files on the clipboard (copied in Finder, or an image copied from a page or app). */
  files: number
  /** How many of those files are images. */
  images: number
}

export type PasteAction = 'files' | 'long-text' | 'default'

export function pasteAction(input: PasteInput): PasteAction {
  // Copying from a document often brings a picture of it along with the
  // text; the words are what was meant, unless there are no words.
  if (input.files > 0 && (input.text.trim() === '' || input.images < input.files)) return 'files'
  if (input.text.trim() !== '' && isLongPaste(input.text)) return 'long-text'
  return 'default'
}

/** Lines the chip shows: a trailing newline doesn't start another one. */
export function lineCount(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return text.endsWith('\n') ? lines - 1 : lines
}

/** Puts pasted text back where the caret is, on its own lines when the draft has text around it. */
export function putBack(draft: string, caret: number, pasted: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const tail = after && !after.startsWith('\n') ? '\n' : ''
  const text = `${before}${lead}${pasted}${tail}${after}`
  return { text, caret: before.length + lead.length + pasted.length }
}
