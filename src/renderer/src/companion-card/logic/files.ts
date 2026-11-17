/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { t } from '@shared/i18n/core'
// The Files tab's list: filtering, sorting and the folder breadcrumb.

export type FileSort = 'name' | 'modified'

export interface FileLike {
  path: string
  name: string
  kind: 'file' | 'folder'
  modifiedAt: number
}

/** Entries whose name contains every word of the query. */
export function filterFiles<T extends FileLike>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)))
}

/** Folders first, then by name (A to Z) or by last change (newest first). */
export function sortFiles<T extends FileLike>(entries: readonly T[], sort: FileSort): T[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
    if (sort === 'modified' && a.modifiedAt !== b.modifiedAt) return b.modifiedAt - a.modifiedAt
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

/** "trips/kyoto" → the top, "trips", "trips/kyoto", each with the path to open it. The top's label is ''. */
export function breadcrumbs(folder: string): Array<{ label: string; path: string }> {
  const parts = folder.split('/').filter(Boolean)
  return [{ label: '', path: '' }, ...parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))]
}

/** DS-115: the muted type column, from the name ("Folder", "PDF", "Markdown", or the extension). */
export function fileTypeLabel(entry: { kind: 'file' | 'folder'; name: string }): string {
  if (entry.kind === 'folder') return t('coCard.files.folder')
  const dot = entry.name.lastIndexOf('.')
  if (dot <= 0 || dot === entry.name.length - 1) return t('coCard.files.file')
  const ext = entry.name.slice(dot + 1).toLowerCase()
  const named: Record<string, string> = { md: t('coCard.files.kindMarkdown'), txt: t('coCard.files.kindText'), pdf: 'PDF', png: t('coCard.files.kindImage', { format: 'PNG' }), jpg: t('coCard.files.kindImage', { format: 'JPEG' }), jpeg: t('coCard.files.kindImage', { format: 'JPEG' }), gif: t('coCard.files.kindImage', { format: 'GIF' }), webp: t('coCard.files.kindImage', { format: 'WebP' }), svg: t('coCard.files.kindImage', { format: 'SVG' }), csv: 'CSV', json: 'JSON', html: 'HTML', docx: t('coCard.files.kindWord'), xlsx: 'Excel', pptx: 'PowerPoint' }
  return named[ext] ?? ext.toUpperCase()
}
