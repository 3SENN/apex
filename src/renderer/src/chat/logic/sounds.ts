/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent, AgentStatus } from '@shared/ipc'
import type { CueSpec } from './cues'

// Chat sounds (NS-03): needs you, done (three rotating variants) and task
// completed, at most once every 1.5 s per chat, only while `chatSounds` is
// on. When a sound plays the matching notification is sent silent (main's
// chatNotificationSilent). The rules are pure; chat/chatSounds.ts wires them.

export type ChatSound = 'needs-you' | 'done' | 'task-completed'

export const SOUND_GAP_MS = 1500

/** Remembers when each chat last made a sound. */
export class SoundGate {
  readonly #last = new Map<string, number>()
  readonly #gap: number

  constructor(gap = SOUND_GAP_MS) {
    this.#gap = gap
  }

  /** True (and noted) when the chat may sound now. */
  allow(chatId: string, now: number): boolean {
    const last = this.#last.get(chatId)
    if (last !== undefined && now - last < this.#gap) return false
    this.#last.set(chatId, now)
    return true
  }
}

interface ChatTrack {
  status: AgentStatus
  /** The current run hit an error or was stopped: it ends without a done sound. */
  failed: boolean
}

/** Events that put a request in front of you. */
const NEEDS_YOU = new Set<AgentEvent['type']>(['approval', 'question', 'site-access', 'table-write', 'connector-approval'])

export interface ChatSoundsDeps {
  enabled(): boolean
  play(cue: CueSpec): void
  now(): number
}

/** Follows every chat's events and plays the cue each one calls for. */
export function createChatSounds(deps: ChatSoundsDeps): { onEvent(chatId: string, event: AgentEvent): ChatSound | null } {
  const gate = new SoundGate()
  const chats = new Map<string, ChatTrack>()
  let doneCount = 0

  const sound = (chatId: string, which: ChatSound): ChatSound | null => {
    if (!deps.enabled() || !gate.allow(chatId, deps.now())) return null
    deps.play(which === 'done' ? { id: 'done', variant: doneCount++ % 3 } : { id: which })
    return which
  }

  return {
    onEvent(chatId, event) {
      const track = chats.get(chatId) ?? { status: 'idle' as AgentStatus, failed: false }
      chats.set(chatId, track)
      if (NEEDS_YOU.has(event.type)) return sound(chatId, 'needs-you')
      switch (event.type) {
        case 'error':
          track.failed = true
          return null
        case 'stopped':
          track.failed = true
          return null
        case 'delegation':
          return event.status === 'done' ? sound(chatId, 'task-completed') : null
        case 'status': {
          const before = track.status
          track.status = event.status
          if (event.status !== 'idle') {
            if (before === 'idle') track.failed = false
            return null
          }
          const failed = track.failed
          track.failed = false
          return before !== 'idle' && !failed ? sound(chatId, 'done') : null
        }
        default:
          return null
      }
    },
  }
}
