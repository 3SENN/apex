/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExportFormat } from '@shared/exportFormat'

// The export dialog's choices (CH-36), pure so the rules are tested: one item
// gets copy, the saves, print and a mail draft; several get only the saves,
// one file each into a folder.

/** The save formats the dialog offers, in its order; text is the copy action. */
export const SAVE_FORMATS: readonly ExportFormat[] = ['markdown', 'html', 'pdf']

export interface ExportActions {
  saves: ExportFormat[]
  copy: boolean
  print: boolean
  mail: boolean
}

export function exportActions(formats: readonly ExportFormat[], count: number): ExportActions {
  const saves = SAVE_FORMATS.filter((f) => formats.includes(f))
  const single = count === 1 && formats.length > 0
  return { saves, copy: single && formats.includes('text'), print: single && formats.includes('html'), mail: single && formats.includes('text') }
}

/** The file name shown after a save, from the path main returns. */
export const exportedName = (path: string): string => path.split(/[\\/]/).pop() || path
