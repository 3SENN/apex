/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { atelier, errorText } from '../../api'
import { meetingStatus, subscribeMeetingStatus } from '../../meetings/status'
import { t } from '@shared/i18n/core'
import { toast } from '../../ui'
import { markSent } from '../store'
import { draftText, setDraftText } from '../surfaces'
import { restoreDraftAttachments, type DraftAttachment } from './drafts'
import { WaitingController, blockingMeetings, type Hold } from './waiting'

// Held sends (MV-14), one per chat, kept outside the composer so a message
// still goes out after you switch chats or close the panel. A hold releases
// the moment its meetings are transcribed; cancelling puts the text and the
// chips back in that chat's composer.

type Extra = DraftAttachment[]

const controllers = new Map<string, WaitingController<Extra>>()
const listeners = new Set<() => void>()
let watching: (() => void) | null = null

function emit(): void {
  for (const fn of [...listeners]) fn()
}

function release(chatId: string, hold: Hold<Extra>): void {
  markSent(chatId)
  void atelier.agent.send(chatId, hold.text, hold.attachments).catch((err: unknown) => {
    markSent(chatId, false)
    giveBack(chatId, hold)
    toast.show({ message: errorText(err), tone: 'error' })
  })
}

function giveBack(chatId: string, hold: Hold<Extra>): void {
  const current = draftText(chatId).trim()
  setDraftText(chatId, current ? `${hold.text}\n\n${current}` : hold.text)
  restoreDraftAttachments(chatId, hold.extra)
}

function controller(chatId: string): WaitingController<Extra> {
  let c = controllers.get(chatId)
  if (!c) {
    c = new WaitingController<Extra>((hold) => release(chatId, hold))
    controllers.set(chatId, c)
  }
  return c
}

function watch(): void {
  if (watching) return
  watching = subscribeMeetingStatus(() => {
    let changed = false
    for (const [chatId, c] of controllers) {
      if (c.update(meetingStatus)) {
        changed = true
        controllers.delete(chatId)
      }
    }
    if (changed) emit()
    if (controllers.size === 0 && watching) {
      watching()
      watching = null
    }
  })
}

/**
 * Holds the message while an attached meeting is still being transcribed,
 * and returns true; returns false (and does nothing) when nothing blocks it,
 * so the caller sends it the ordinary way.
 */
export function holdIfWaiting(chatId: string, text: string, items: DraftAttachment[]): boolean {
  const attachments = items.map((i) => i.attachment)
  if (blockingMeetings(attachments, meetingStatus).length === 0) return false
  const c = controller(chatId)
  const { replaced } = c.offer(text, attachments, items, meetingStatus)
  if (replaced) giveBack(chatId, replaced)
  watch()
  emit()
  toast.show({ message: t('meetings.waiting.toast'), tone: 'info' })
  return true
}

export function heldSend(chatId: string): Hold<Extra> | null {
  return controllers.get(chatId)?.hold ?? null
}

/** Cancels the hold and puts the message back in the composer. */
export function cancelHold(chatId: string): Hold<Extra> | null {
  const c = controllers.get(chatId)
  const hold = c?.cancel() ?? null
  controllers.delete(chatId)
  if (hold) {
    giveBack(chatId, hold)
    emit()
  }
  return hold
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useHeldSend(chatId: string): Hold<Extra> | null {
  return useSyncExternalStore(subscribe, () => heldSend(chatId))
}
