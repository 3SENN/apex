/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { formatKeys, shortcutById, type ShortcutId } from '@shared/shortcuts'
import { apex } from '../api'
import { cx } from './logic/format'
import { shortcutParts } from './logic/shortcut'

// Key caps for a shortcut: the table row's platform keys, or an
// accelerator through the same parser the menus use. Tooltips, the ⌘/ sheet
// and the main menu render these. `tone="inverse"` sits on the dark tooltip.

export interface KeyCapsProps {
  /** A row of the shortcut table. */
  shortcutId?: ShortcutId | string | null
  /** An Electron accelerator, when there is no table row. */
  accelerator?: string
  /** Literal caps. */
  keys?: string[]
  tone?: 'default' | 'inverse'
  className?: string
}

/** The caps for a table row on this platform, or [] when the id is unknown. */
export function capsFor(shortcutId: string | null | undefined, platform: string = apex.platform): string[] {
  if (!shortcutId) return []
  const def = shortcutById(shortcutId as ShortcutId)
  return def ? formatKeys(def, platform) : []
}

export function KeyCaps({ shortcutId, accelerator, keys, tone = 'default', className }: KeyCapsProps): ReactElement | null {
  const caps = keys ?? (shortcutId ? capsFor(shortcutId) : accelerator ? shortcutParts(accelerator, apex.platform === 'darwin') : [])
  if (caps.length === 0) return null
  return (
    <span className={cx('ui-keycaps', tone === 'inverse' && 'ui-keycaps--inverse', className)} aria-hidden="true">
      {caps.map((cap, i) => (
        <kbd key={i} className="ui-keycap">
          {cap}
        </kbd>
      ))}
    </span>
  )
}
