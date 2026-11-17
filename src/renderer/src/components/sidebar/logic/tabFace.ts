/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompanionMood } from '@shared/companion'
import type { TabInfo } from '@shared/ipc'
import type { AvatarMark } from '../../../companion/presenceCore'

export type TabFaceState = 'working' | 'waiting' | 'done'

export interface TabFace {
  state: TabFaceState
  /** The chat whose companion the head shows (null: the active companion). */
  chatId: string | null
  mood: CompanionMood
  /** The state mark drawn beside the head. */
  mark: AvatarMark
}

/**
 * DS-67: a tab row follows the head-plus-mark rule. A tab a companion works
 * in, waits in or just finished in shows that companion's frameless head
 * with one state mark beside it (working, waiting for you, done), never a
 * bare face plus a separate trailing dot or check. Waiting for you wins.
 */
export function tabFace(tab: Pick<TabInfo, 'agentControlled' | 'agentChatId' | 'needsInput'>, finished: boolean): TabFace | null {
  const chatId = tab.agentChatId ?? null
  if (tab.needsInput) return { state: 'waiting', chatId, mood: 'approval', mark: 'approval' }
  if (tab.agentControlled) return { state: 'working', chatId, mood: 'working', mark: 'working' }
  if (finished) return { state: 'done', chatId, mood: 'happy', mark: 'done' }
  return null
}
