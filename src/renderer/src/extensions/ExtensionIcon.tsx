/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement } from 'react'
import { Puzzle } from 'lucide-react'
import { badgeTextColor, type ExtensionInfo } from '@shared/extensions'
import { cx } from '../ui'

// An extension's icon, or a neutral puzzle glyph when it has none.
// The badge keeps the extension's own colour; its text turns black or white
// for contrast, and without a usable colour both come from theme tokens.

export function ExtensionIcon({ ext, size = 16, dimmed = false }: { ext: Pick<ExtensionInfo, 'icon'>; size?: number; dimmed?: boolean }): ReactElement {
  return (
    <span className={cx('ext-icon', dimmed && 'ext-icon--dimmed')} style={{ width: size, height: size }} aria-hidden>
      {ext.icon ? <img src={ext.icon} alt="" width={size} height={size} draggable={false} /> : <Puzzle size={size} />}
    </span>
  )
}

export function ExtensionBadge({ badge }: { badge: NonNullable<ExtensionInfo['badge']> }): ReactElement {
  const ink = badge.color ? badgeTextColor(badge.color) : null
  const style: CSSProperties | undefined = ink ? { background: badge.color, color: ink } : undefined
  return (
    <span className="ext-badge" style={style} aria-hidden>
      {badge.text}
    </span>
  )
}
