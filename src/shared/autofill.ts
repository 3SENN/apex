/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Autofill in pages: the frame channels, the overlay surfaces'
// props, the settings group and the autofill service the surfaces call.
import type { FieldKind, FormRole, GuardKind } from './fields'
import type { Bounds } from './ipc'

/** Page-frame channels. Every frame (nested and cross-origin too) runs the page preload. */
export const PAGE_AUTOFILL = {
  /** any frame -> main, routed by event.senderFrame */
  report: 'apex-autofill:report',
  /** main -> WebFrameMain.send */
  command: 'apex-autofill:command',
} as const

/** What ended a form: the submit event, Enter, a submit control, the form leaving the page, or the page going away. */
export type SubmitTrigger = 'submit' | 'enter' | 'click' | 'removed' | 'pagehide'

// Rects in reports are CSS px in the reporting frame's own viewport; main
// composes frame offsets and the zoom into tab coordinates.
export type FrameReport =
  | {
      type: 'focus'
      fieldId: string
      kind: FieldKind
      rect: Bounds
      formId: string
      filled: { username: boolean; password: boolean }
      typed: boolean
      trusted: true
      /** What the field's group is for. */
      formRole: FormRole
      /** The username already in the group, to preselect a matching login. */
      username?: string
    }
  | { type: 'blur'; fieldId: string }
  /** The focused field moved without a scroll (a resize or a reflow); the popup follows and the stillness timer restarts. */
  | { type: 'moved'; fieldId: string; rect: Bounds }
  | { type: 'key'; key: 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Escape' }
  | { type: 'scroll' }
  | { type: 'submit'; form: 'login' | 'card' | 'address'; values: Record<string, string>; trigger?: SubmitTrigger }
  | { type: 'probe'; nonce: string; childRect: Bounds }
  /** `focused` is the guard of the frame's focused field while the frame has focus. */
  | { type: 'guarded'; rects: Bounds[]; focused?: GuardKind | null }

export type MainCommand =
  | { type: 'fill'; values: Partial<Record<FieldKind, string>>; formId: string }
  /** `active`: a row is highlighted, so Enter picks it instead of submitting. */
  | { type: 'popup'; open: boolean; active?: boolean }
  | { type: 'probe-parent'; nonce: string }
  | { type: 'report-guarded' }

export type { FieldKind, FormRole, GuardKind }

export interface AutofillSettings {
  offerLogins: boolean
  offerSave: boolean
  offerGenerated: boolean
  addresses: boolean
  /** Ask for Touch ID before filling an address. */
  addressAuth: boolean
  cards: boolean
  /** Ask for Touch ID before filling a card. */
  cardAuth: boolean
  importHintDismissed: boolean
  passwordsImported: boolean
  /**
   * While a password extension (Apple Passwords, or any that turns off the
   * browser's password saving through chrome.privacy) is on, Apex's own
   * password fill offers and save prompts step aside. Address and card
   * autofill keep working. Off keeps Apex's offers as well.
   */
  yieldToPasswordExtension: boolean
}

/** A pick counts only once the popup has been visible and still this long (OV-25). */
export const STILLNESS_MS = 500
/** Popups stay at least this far inside the tab. */
export const POPUP_MARGIN = 8
/** Passkey rows are designed in but hidden: builds with Apple's browser passkey entitlement use the system's own passkey sheet instead (docs/release.md). */
export const PASSKEY_ROWS_VISIBLE = false


/** One row of a fill popup. Never carries a password or a card number. */
export interface FillRow {
  id: string
  /** 'generated' is the strong-password row; 'manage' opens apex://passwords or Settings; 'passkey' is hidden. */
  kind: 'login' | 'card' | 'address' | 'generated' | 'manage' | 'passkey'
  title: string
  subtitle?: string
  /** For logins: the site's favicon URL. For cards: the brand. */
  icon?: string
}

export interface FillPopupProps {
  popupId: string
  rows: FillRow[]
  anchorRect: Bounds
  siteLabel: string
  /** Set when the field sits in a cross-site frame. */
  embeddingSite?: string
  /** The row the arrow keys highlight. */
  activeId?: string | null
}

/** The save and update cards. Only the username is ever shown; the password stays masked. */
export interface SaveOfferProps {
  offerId: string
  kind: 'login' | 'card' | 'address'
  mode: 'save' | 'update'
  fields: Array<{ key: string; label: string; value: string; masked?: boolean }>
  anchorRect: Bounds
  siteLabel: string
  embeddingSite?: string
}

export interface ImportHintProps {
  offerId: string
  anchorRect: Bounds
  siteLabel: string
}

export type PickResult = 'filled' | 'too-soon' | 'auth-cancelled' | 'gone'
export type OfferAction = 'save' | 'update' | 'never' | 'dismiss'


export interface AutofillServices {
  /** Called by the autofill overlay surfaces. */
  autofill: {
    pick(popupId: string, itemId: string): Promise<PickResult>
    useGenerated(popupId: string): Promise<void>
    dismiss(popupId: string): void
    /** Starts the 500 ms stillness timer; any change restarts it. */
    surfaceShown(popupId: string, rect: Bounds): void
    respondOffer(offerId: string, action: OfferAction, edited?: { username: string; password: string }): Promise<void>
    dismissImportHint(): void
  }
}

/** Autofill emits no app events of its own; saved logins arrive as 'passwords' events. */
export type AutofillAppEvent = never
