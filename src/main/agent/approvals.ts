/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Approval modes (ST-12, CH-39) and the decision before every browser
// action, on both engines. Standard asks before consequential actions;
// Ask for everything asks before every acting member; Don't ask lives in
// memory only, so a relaunch always starts from the stored mode. Payment and
// account-security actions ask in every mode, with scope 'once' only, and
// password, one-time-code and payment fields stay blocked outright (the autofill
// guard). A consequential action a saved rule allows runs after the
// auto-approval countdown (CH-42).
import { EventEmitter } from 'node:events'
import type { ActionKind, ApprovalMode, ApprovalScope, StoredApprovalMode } from '@shared/agentTools'
import type { GuardResult } from './guard'

/** Members that act on a page; Ask for everything asks before each of them. */
export const ACTING_MEMBERS: ReadonlySet<string> = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'hover', 'mouse_move',
  'type', 'key', 'hold_key', 'form_input', 'navigate',
])

/** Members that only read; they never ask, in any mode. */
export const READ_MEMBERS: ReadonlySet<string> = new Set(['read_page', 'find', 'get_page_text', 'screenshot', 'zoom', 'scroll'])

const BROAD_SCOPES: readonly ApprovalScope[] = ['once', 'chat', 'site']
const ONCE: readonly ApprovalScope[] = ['once']

/** The kind an ordinary acting member counts as, for Ask for everything and saved grants. */
export function memberAction(member: string): ActionKind {
  if (member === 'navigate') return 'navigate'
  if (member === 'type' || member === 'form_input' || member === 'key' || member === 'hold_key') return 'input'
  return 'other'
}

export interface ApprovalInput {
  mode: ApprovalMode
  member: string
  /** The consequential classification of a click or Enter, or null. */
  guard: GuardResult | null
  /** A saved rule that allows this kind of action on this site: from this chat, or for the site. */
  savedRule: 'chat' | 'site' | null
  /** The legacy "Ask before consequential actions" switch. */
  confirmConsequential: boolean
  /** The chat's own "act without asking" (CH-17). */
  chatDontAsk: boolean
}

export type ApprovalDecision =
  | { kind: 'run' }
  | { kind: 'ask'; action: ActionKind; scopes: ApprovalScope[]; alwaysAsk: boolean }
  | { kind: 'countdown'; action: ActionKind; rule: 'chat' | 'site' }

/** What happens before one browser action. Pure, so every rule is unit-tested. */
export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const { guard } = input
  if (guard?.alwaysAsk) return { kind: 'ask', action: guard.action, scopes: [...ONCE], alwaysAsk: true }
  if (input.mode === 'dont-ask' || input.chatDontAsk) return { kind: 'run' }
  if (guard) {
    if (input.mode === 'standard' && !input.confirmConsequential) return { kind: 'run' }
    if (input.savedRule) return { kind: 'countdown', action: guard.action, rule: input.savedRule }
    return { kind: 'ask', action: guard.action, scopes: [...BROAD_SCOPES], alwaysAsk: false }
  }
  if (input.mode === 'ask-all' && ACTING_MEMBERS.has(input.member)) {
    if (input.savedRule) return { kind: 'run' }
    return { kind: 'ask', action: memberAction(input.member), scopes: [...BROAD_SCOPES], alwaysAsk: false }
  }
  return { kind: 'run' }
}

/** The scope an answer may use: always-ask actions are allowed once only. */
export function clampScope(scope: ApprovalScope, scopes: readonly ApprovalScope[]): ApprovalScope {
  return scopes.includes(scope) ? scope : 'once'
}

/**
 * The effective approval mode. 'dont-ask' is held here and never written;
 * choosing Standard or Ask for everything writes the setting and clears it.
 * Emits `changed` whenever the effective mode changes, from here or from Settings.
 */
export class ApprovalModeState extends EventEmitter<{ changed: [ApprovalMode] }> {
  readonly #stored: () => StoredApprovalMode
  readonly #persist: (mode: StoredApprovalMode) => void
  #dontAsk = false
  #last: ApprovalMode

  constructor(stored: () => StoredApprovalMode, persist: (mode: StoredApprovalMode) => void) {
    super()
    this.#stored = stored
    this.#persist = persist
    this.#last = this.get()
  }

  get(): ApprovalMode {
    return this.#dontAsk ? 'dont-ask' : this.#stored()
  }

  set(mode: ApprovalMode): ApprovalMode {
    if (mode === 'dont-ask') {
      this.#dontAsk = true
    } else {
      this.#dontAsk = false
      if (this.#stored() !== mode) this.#persist(mode)
    }
    this.storedChanged()
    return this.get()
  }

  /** Settings changed underneath (another surface wrote approvalMode). */
  storedChanged(): void {
    const now = this.get()
    if (now === this.#last) return
    this.#last = now
    this.emit('changed', now)
  }
}
