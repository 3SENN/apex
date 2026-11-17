/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { AppWindow, AudioLines, Database, FileSpreadsheet, FileText, Globe, ImageIcon, MessageSquare, Quote, ScrollText, Sparkles } from 'lucide-react'
import type { AttachmentKind } from '@shared/attachments'

// One glyph per attachment kind, for chips and menu rows (Atelier's own set).

export function KindIcon({ kind }: { kind: AttachmentKind }): ReactElement {
  switch (kind) {
    case 'image':
      return <ImageIcon aria-hidden="true" />
    case 'pdf':
    case 'text':
      return <FileText aria-hidden="true" />
    case 'office':
      return <FileSpreadsheet aria-hidden="true" />
    case 'tab':
      return <AppWindow aria-hidden="true" />
    case 'selection':
      return <Quote aria-hidden="true" />
    case 'paste':
      return <ScrollText aria-hidden="true" />
    case 'chat':
      return <MessageSquare aria-hidden="true" />
    case 'skill':
      return <Sparkles aria-hidden="true" />
    case 'meeting':
      return <AudioLines aria-hidden="true" />
    case 'connector-record':
      return <Database aria-hidden="true" />
  }
}

/** A site's favicon, or a neutral globe when it has none (or it fails to load). */
export function Favicon({ src }: { src: string | null | undefined }): ReactElement {
  if (!src) return <Globe aria-hidden="true" />
  return (
    <img
      className="cmp-favicon"
      src={src}
      alt=""
      draggable={false}
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden'
      }}
    />
  )
}
