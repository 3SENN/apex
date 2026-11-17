/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ATTACHMENT_LIMITS, type AttachmentKind, type AttachmentRef, type RefAttachment } from '@shared/attachments'
import { t } from '@shared/i18n/core'

// Pure rules behind the composer's chips (CH-22): what each chip says, and
// whether Send can go now, must wait, or is blocked, with the hint that says
// why. The intake in main refuses a message whose refs aren't ready anyway;
// this keeps the button honest before it gets that far.

export type ChipState = 'preparing' | 'ready' | 'failed'

export interface ChipView {
  id: string
  kind: AttachmentKind
  name: string
  /** Lines, pages, the source's host, or the failure reason. */
  sublabel: string | null
  state: ChipState
  thumbnail: string | null
  /** The page a selection or tab came from (opened from the chip). */
  sourceUrl: string | null
  /** Pasted text opens the preview. */
  previewable: boolean
  /** Tab chips borrow the tab's favicon. */
  tabId: string | null
}

export function hostLabel(url: string): string {
  try {
    const host = new URL(url).hostname
    return host.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

export function chipView(ref: AttachmentRef): ChipView {
  const sourceUrl = ref.source?.url && /^https?:/.test(ref.source.url) ? ref.source.url : null
  let sublabel: string | null = null
  if (ref.state === 'failed') sublabel = ref.error ?? t('composer.chip.failed')
  // MV-14: a meeting waits for its transcript; Remove on the chip cancels it.
  else if (ref.state === 'preparing') sublabel = ref.kind === 'meeting' ? t('composer.chip.waiting') : t('composer.chip.preparing')
  else if (ref.lines !== undefined && (ref.kind === 'paste' || ref.kind === 'text')) sublabel = t('composer.paste.lines', { count: ref.lines })
  else if (ref.pages !== undefined) sublabel = t('composer.chip.pages', { count: ref.pages })
  else if (sourceUrl) sublabel = hostLabel(sourceUrl)
  return {
    id: ref.id,
    kind: ref.kind,
    name: ref.name || (ref.kind === 'paste' ? t('composer.paste.title') : t('composer.mention.untitled')),
    sublabel,
    state: ref.state,
    thumbnail: ref.thumbnail,
    sourceUrl,
    previewable: ref.kind === 'paste' && ref.state === 'ready',
    tabId: ref.source?.tabId ?? null,
  }
}

export interface Gate {
  /** Send can go out now. */
  canSend: boolean
  /** Why it can't (the button's tooltip and the row's status), or null. */
  hint: string | null
}

/**
 * Send waits while any chip is preparing, and is blocked while one failed
 * (retry or remove it) or the message holds more than the limit. `extra`
 * counts the meeting and screenshot chips sharing the message.
 */
export function intakeGate(items: readonly Pick<AttachmentRef, 'state'>[], extra = 0): Gate {
  if (items.length + extra > ATTACHMENT_LIMITS.perMessage) return { canSend: false, hint: t('composer.gate.tooMany', { count: ATTACHMENT_LIMITS.perMessage }) }
  if (items.some((a) => a.state === 'failed')) return { canSend: false, hint: t('composer.gate.failed') }
  if (items.some((a) => a.state === 'preparing')) return { canSend: false, hint: t('composer.gate.preparing') }
  return { canSend: true, hint: null }
}

// ---- editing a sent message (CH-09) ----

/** Older attachment entries normalized on load have no store entry, so they can't be sent again by reference. */
export const isLegacyRef = (ref: Pick<AttachmentRef, 'id'>): boolean => ref.id.startsWith('legacy-')

/** What editAndResend gets: undefined keeps the message's attachments as they were. */
export function editedAttachments(original: readonly AttachmentRef[], keptIds: readonly string[], addedIds: readonly string[]): RefAttachment[] | undefined {
  const kept = original.filter((a) => keptIds.includes(a.id))
  if (kept.length === original.length && addedIds.length === 0) return undefined
  return [...kept.filter((a) => !isLegacyRef(a)).map((a) => a.id), ...addedIds].map((id) => ({ kind: 'ref', id }))
}

/**
 * The chips once main's reply to add, pick or retry lands. Main sends its
 * 'attachments' event for every change before it replies, and a quick
 * preparation (a quote, a paste) can be ready before the reply arrives, so a
 * ref an event already brought is newer than the reply's and stays (else the
 * chip would say "Preparing…" for good and hold the send).
 */
export function withReplyRef(items: readonly AttachmentRef[], ref: AttachmentRef): AttachmentRef[] | null {
  return items.some((a) => a.id === ref.id) ? null : [...items, ref]
}
