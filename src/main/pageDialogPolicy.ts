/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DialogSpec } from '@shared/dialogs'
import type { PageDialogMessage, PageDialogReply } from '@shared/ipc'
import { t } from '@shared/i18n/core'

// Rules for a page's alert, confirm and prompt (OV-08), free of
// Electron so they are unit-tested: which dialogs are let through, when
// "Stop this site from showing dialogs" is offered, what each answer
// returns to the page, and how a dialog is worded.

/** A page dialog nobody answers is cancelled after this long. */
export const PAGE_DIALOG_TIMEOUT_MS = 5 * 60_000
/** From the second dialog of a page on, the stop checkbox is offered. */
export const OFFER_STOP_AFTER = 1
/** More dialogs than this inside the window are a loop: further ones are cancelled. */
export const BURST_LIMIT = 8
export const BURST_WINDOW_MS = 15_000
/** Long messages are shortened for the dialog; the page still gets its answer. */
export const MESSAGE_SHOWN_MAX = 4000

export interface TabDialogState {
  /** Dialogs shown since the page's document loaded. */
  shown: number
  /** When recent dialogs were asked, for the burst limit. */
  recent: number[]
  /** Sites this tab stopped from showing dialogs, until it closes. */
  blocked: Set<string>
}

export function newTabDialogState(): TabDialogState {
  return { shown: 0, recent: [], blocked: new Set() }
}

/** A new document starts counting again; stopped sites stay stopped. */
export function documentChanged(state: TabDialogState): void {
  state.shown = 0
  state.recent = []
}

export type PageDialogDecision = { kind: 'block' } | { kind: 'show'; offerStop: boolean }

/** Whether a dialog from `origin` shows, and whether to offer stopping the site. Records the attempt. */
export function decide(state: TabDialogState, origin: string, now: number): PageDialogDecision {
  if (state.blocked.has(origin)) return { kind: 'block' }
  state.recent = state.recent.filter((at) => now - at < BURST_WINDOW_MS)
  if (state.recent.length >= BURST_LIMIT) return { kind: 'block' }
  state.recent.push(now)
  const offerStop = state.shown >= OFFER_STOP_AFTER
  state.shown++
  return { kind: 'show', offerStop }
}

/** What the page gets when a dialog is blocked, cancelled or times out. */
export function cancelReply(kind: PageDialogMessage['kind']): PageDialogReply {
  return kind === 'confirm' ? false : null
}

/** The page's answer from the dialog's buttons and input. */
export function replyFor(kind: PageDialogMessage['kind'], button: string | null, value: string | undefined): PageDialogReply {
  if (kind === 'alert') return null
  if (kind === 'confirm') return button === 'ok'
  return button === 'ok' ? (value ?? '') : null
}

/** "example.com" for an http(s) origin; null for opaque ones (data:, about:blank, file:). */
export function siteLabel(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.host.replace(/^www\./, '')
  } catch {
    return null
  }
}

function shorten(message: string): string {
  return message.length > MESSAGE_SHOWN_MAX ? `${message.slice(0, MESSAGE_SHOWN_MAX)}…` : message
}

/** The dialog for a page's alert, confirm or prompt. The title names the site, so a page can't pose as Atelier. */
export function pageDialogSpec(msg: PageDialogMessage, origin: string, offerStop: boolean): DialogSpec {
  const site = siteLabel(origin)
  const title = site ? t('menus.pageDialog.title', { site }) : t('menus.pageDialog.titleUnknown')
  const ok = { id: 'ok', label: t('menus.dialog.ok'), style: 'primary' as const, enter: true, align: 'end' as const }
  const cancel = { id: 'cancel', label: t('menus.dialog.cancel'), style: 'secondary' as const, escape: true, align: 'end' as const }
  return {
    title,
    ...(msg.message ? { description: shorten(msg.message) } : {}),
    ...(msg.kind === 'prompt' ? { inputs: [{ id: 'value', label: t('menus.pageDialog.answer'), type: 'text' as const, value: msg.defaultValue ?? '' }] } : {}),
    ...(offerStop ? { checkbox: { label: t('menus.pageDialog.stop'), checked: false } } : {}),
    buttons: msg.kind === 'alert' ? [{ ...ok, escape: true }] : [cancel, ok],
  }
}

/** What the agent hears about a dialog on a tab it controls; it asks you before answering. */
export function agentNote(msg: PageDialogMessage, origin: string): string {
  const site = siteLabel(origin) ?? 'The page'
  const text = msg.message.length > 500 ? `${msg.message.slice(0, 500)}…` : msg.message
  return `${site} opened a ${msg.kind} dialog${text ? `: "${text}"` : ''}. It waits for the person to answer; ask them before acting on it.`
}
