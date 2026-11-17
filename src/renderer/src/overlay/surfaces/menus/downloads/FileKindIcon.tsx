/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Package, Presentation, type LucideIcon } from 'lucide-react'
import type { FileKind } from '@shared/downloads'

// The file-type glyph shared by the downloads popover, the flight and the
// Downloads page. Neutral tokens only: the tile reads the same in light and dark.

const ICONS: Record<FileKind, LucideIcon> = {
  archive: FileArchive,
  installer: Package,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  doc: FileText,
  code: FileCode,
  file: File,
}

export function FileKindIcon({ kind, className }: { kind: FileKind; className?: string }): ReactElement {
  const Icon = ICONS[kind]
  return (
    <span className={className ?? 'dl-kind'} data-kind={kind} aria-hidden>
      <Icon />
    </span>
  )
}
