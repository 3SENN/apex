/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UNSETTLED_STATUSES, type MeetingStatus } from '@shared/meetings'
import type { MessageAttachment } from '@shared/chats'

// MV-14's waiting rule, kept pure: a message with an attached meeting whose
// transcript is still being finished is held, and goes out the moment every
// such meeting has left live and finishing. The chip can cancel the hold.

/** A meeting's status, or null when the library doesn't know it (deleted, or not loaded yet). */
export type StatusOf = (meetingId: string) => MeetingStatus | null

/** The attached meetings the message still has to wait for. */
export function blockingMeetings(attachments: readonly MessageAttachment[], status: StatusOf): string[] {
  return attachments.flatMap((a) => {
    if (a.kind !== 'meeting') return []
    const s = status(a.meetingId)
    return s !== null && UNSETTLED_STATUSES.includes(s) ? [a.meetingId] : []
  })
}

export interface Hold<T = unknown> {
  text: string
  attachments: MessageAttachment[]
  /** Whatever the caller needs back on release or cancel (the chips' labels). */
  extra: T
  waitingFor: string[]
  since: number
}

/**
 * One chat's held send. `offer` either sends at once or holds; `update`
 * releases the hold once nothing blocks it; `cancel` hands it back.
 */
export class WaitingController<T = unknown> {
  #hold: Hold<T> | null = null
  readonly #send: (hold: Hold<T>) => void

  constructor(send: (hold: Hold<T>) => void) {
    this.#send = send
  }

  get hold(): Hold<T> | null {
    return this.#hold
  }

  /** Sends now when nothing blocks; otherwise holds (replacing an earlier hold, which is returned). */
  offer(text: string, attachments: MessageAttachment[], extra: T, status: StatusOf, now = Date.now()): { held: boolean; replaced: Hold<T> | null } {
    const waitingFor = blockingMeetings(attachments, status)
    const hold: Hold<T> = { text, attachments, extra, waitingFor, since: now }
    if (waitingFor.length === 0) {
      this.#send(hold)
      return { held: false, replaced: null }
    }
    const replaced = this.#hold
    this.#hold = hold
    return { held: true, replaced }
  }

  /** Re-checks the hold against fresh statuses; true when it was released (and sent). */
  update(status: StatusOf): boolean {
    const hold = this.#hold
    if (!hold) return false
    const waitingFor = blockingMeetings(hold.attachments, status)
    if (waitingFor.length > 0) {
      hold.waitingFor = waitingFor
      return false
    }
    this.#hold = null
    this.#send(hold)
    return true
  }

  cancel(): Hold<T> | null {
    const hold = this.#hold
    this.#hold = null
    return hold
  }
}
