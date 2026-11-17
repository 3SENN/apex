/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react'
import type { ChatSummary } from '@shared/chats'
import { useChatList } from '../chat/hooks'

// Which routines are running right now. A run is a background chat
// with its routine's id, so the live chat list already knows; the Routines
// page rows and the sidebar's Routines row read it from here.

export function runningRoutines(chats: readonly Pick<ChatSummary, 'routineId' | 'status'>[] | null): Set<string> {
  const out = new Set<string>()
  for (const chat of chats ?? []) if (chat.routineId && (chat.status === 'running' || chat.status === 'needs-approval')) out.add(chat.routineId)
  return out
}

export function useRunningRoutines(): Set<string> {
  const chats = useChatList()
  const running = runningRoutines(chats)
  // A stable set while the members stay the same, so rows don't re-render on every chat event.
  const key = [...running].sort().join('|')
  return useMemo(() => running, [key])
}
