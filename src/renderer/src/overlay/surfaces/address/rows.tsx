/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import type { MessageKey } from '@shared/i18n/core'
import type { useT } from '../../../i18n/useT'

// Shared by the command bar and universal search: group headings and the
// matched-text highlight.

const GROUP_KEYS: Record<string, MessageKey> = {
  typed: 'address.group.typed',
  top: 'address.group.top',
  ask: 'address.group.ask',
  suggest: 'address.group.suggestions',
  tabs: 'address.group.tabs',
  bookmarks: 'address.group.bookmarks',
  history: 'address.group.history',
  commands: 'address.group.commands',
  settings: 'address.group.settings',
  chats: 'address.group.chats',
  pages: 'address.group.settings',
  packs: 'address.group.packs',
  apps: 'address.group.apps',
}

/** A group's heading; a group without a catalogue key shows its own id. */
export function groupLabel(group: string, t: ReturnType<typeof useT>): string {
  const key = GROUP_KEYS[group]
  return key ? t(key) : group.charAt(0).toUpperCase() + group.slice(1)
}

/** Wraps the matched [start, end) ranges of `text` in <mark>. */
export function highlight(text: string, ranges: readonly [number, number][] | undefined): ReactNode {
  if (!ranges || ranges.length === 0) return text
  const out: ReactNode[] = []
  let at = 0
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < at || end <= start || start >= text.length) continue
    if (start > at) out.push(text.slice(at, start))
    out.push(<mark key={start}>{text.slice(start, Math.min(end, text.length))}</mark>)
    at = Math.min(end, text.length)
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}
