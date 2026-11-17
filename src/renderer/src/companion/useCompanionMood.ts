/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react'
import type { CompanionMood } from '@shared/companion'
import { signalPresence, useCompanionPresence } from './presence'

/**
 * A companion's mood from the presence store (presence.ts): its chats'
 * agent events, every composer's typing and sends, and idle time. Kept for
 * callers that want a listening switch; new code can use
 * useCompanionPresence and signalPresence directly.
 */
export function useCompanionMood(companionId: string | null | undefined): { mood: CompanionMood; talkPulse: number; setListening(listening: boolean): void } {
  const { mood, talkPulse } = useCompanionPresence(companionId)
  const setListening = useCallback((value: boolean) => signalPresence(value ? 'typing' : 'idle', companionId), [companionId])
  return { mood, talkPulse, setListening }
}
