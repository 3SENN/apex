/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { ALWAYS_ASK, type ApprovalMode, type StoredApprovalMode } from '@shared/agentTools'
import type { ElementDescription } from '@shared/ipc'
import { SETTINGS } from '@shared/settingsRegistry'
import { ACTING_MEMBERS, ApprovalModeState, clampScope, decideApproval, READ_MEMBERS, type ApprovalInput } from '../src/main/agent/approvals'
import { guardAction, type GuardResult } from '../src/main/agent/guard'

// Approval modes (ST-12, CH-39): Don't ask is never persisted, Ask for
// everything covers every acting member, reads never ask, and payment and
// account-security actions ask in every mode with scope 'once' only.

function input(overrides: Partial<ApprovalInput>): ApprovalInput {
  return { mode: 'standard', member: 'left_click', guard: null, savedRule: null, confirmConsequential: true, chatDontAsk: false, ...overrides }
}

const purchase: GuardResult = { reason: 'click button "Buy now"', action: 'purchase', alwaysAsk: false }
const payment: GuardResult = { reason: 'submit a payment form', action: 'payment', alwaysAsk: true }

function el(overrides: Partial<ElementDescription>): ElementDescription {
  return { role: 'button', name: '', tag: 'button', inForm: false, formHasPaymentFields: false, ...overrides } as ElementDescription
}

describe('ApprovalModeState', () => {
  function state(initial: StoredApprovalMode = 'standard') {
    let stored: StoredApprovalMode = initial
    const writes: StoredApprovalMode[] = []
    const changes: ApprovalMode[] = []
    const mode = new ApprovalModeState(() => stored, (next) => {
      stored = next
      writes.push(next)
    })
    mode.on('changed', (m) => changes.push(m))
    return { mode, writes, changes, stored: () => stored, setStored: (m: StoredApprovalMode) => (stored = m) }
  }

  it('keeps Don’t ask in memory only, and a relaunch starts from the stored mode', () => {
    const s = state('ask-all')
    expect(s.mode.set('dont-ask')).toBe('dont-ask')
    expect(s.mode.get()).toBe('dont-ask')
    expect(s.writes).toEqual([])
    expect(s.stored()).toBe('ask-all')
    expect(s.changes).toEqual(['dont-ask'])
    // "Relaunch": a new state over the same stored value.
    const relaunched = new ApprovalModeState(s.stored, () => undefined)
    expect(relaunched.get()).toBe('ask-all')
  })

  it('writes Standard and Ask for everything, and fires agent-mode changes once each', () => {
    const s = state()
    s.mode.set('ask-all')
    s.mode.set('ask-all')
    s.mode.set('dont-ask')
    s.mode.set('standard')
    expect(s.writes).toEqual(['ask-all', 'standard'])
    expect(s.changes).toEqual(['ask-all', 'dont-ask', 'standard'])
  })

  it('follows the stored setting when another surface changes it', () => {
    const s = state()
    s.setStored('ask-all')
    s.mode.storedChanged()
    expect(s.changes).toEqual(['ask-all'])
    // While Don't ask is on, a stored change doesn't change the effective mode.
    s.mode.set('dont-ask')
    s.setStored('standard')
    s.mode.storedChanged()
    expect(s.mode.get()).toBe('dont-ask')
  })

  it('the settings registry can’t store Don’t ask', () => {
    expect(SETTINGS.approvalMode.schema.safeParse('dont-ask').success).toBe(false)
    expect(SETTINGS.approvalMode.schema.safeParse('ask-all').success).toBe(true)
    expect(SETTINGS.approvalMode.default).toBe('standard')
  })
})

describe('decideApproval', () => {
  it('Standard asks before consequential actions with every scope, and lets ordinary ones run', () => {
    expect(decideApproval(input({ guard: purchase }))).toEqual({ kind: 'ask', action: 'purchase', scopes: ['once', 'chat', 'site'], alwaysAsk: false })
    expect(decideApproval(input({ member: 'type' }))).toEqual({ kind: 'run' })
    expect(decideApproval(input({ member: 'navigate' }))).toEqual({ kind: 'run' })
  })

  it('Ask for everything asks before every acting member, and never before a read', () => {
    const acting = ['left_click', 'right_click', 'double_click', 'triple_click', 'left_click_drag', 'hover', 'type', 'key', 'hold_key', 'form_input', 'navigate']
    for (const member of acting) {
      expect(ACTING_MEMBERS.has(member)).toBe(true)
      expect(decideApproval(input({ mode: 'ask-all', member })).kind).toBe('ask')
    }
    for (const member of ['read_page', 'find', 'get_page_text', 'screenshot', 'zoom', 'scroll']) {
      expect(READ_MEMBERS.has(member)).toBe(true)
      expect(ACTING_MEMBERS.has(member)).toBe(false)
      expect(decideApproval(input({ mode: 'ask-all', member }))).toEqual({ kind: 'run' })
    }
    expect(decideApproval(input({ mode: 'ask-all', member: 'navigate' }))).toMatchObject({ action: 'navigate' })
    expect(decideApproval(input({ mode: 'ask-all', member: 'form_input' }))).toMatchObject({ action: 'input' })
    // A rule saved for this kind on this site lets an ordinary step run.
    expect(decideApproval(input({ mode: 'ask-all', member: 'type', savedRule: 'site' }))).toEqual({ kind: 'run' })
  })

  it('Don’t ask runs everything except actions that always ask', () => {
    expect(decideApproval(input({ mode: 'dont-ask', guard: purchase }))).toEqual({ kind: 'run' })
    expect(decideApproval(input({ mode: 'dont-ask', guard: payment }))).toEqual({ kind: 'ask', action: 'payment', scopes: ['once'], alwaysAsk: true })
    expect(decideApproval(input({ chatDontAsk: true, guard: payment }))).toMatchObject({ kind: 'ask', scopes: ['once'] })
  })

  it('a saved rule turns a consequential action into a countdown, except always-ask ones', () => {
    expect(decideApproval(input({ guard: purchase, savedRule: 'chat' }))).toEqual({ kind: 'countdown', action: 'purchase', rule: 'chat' })
    expect(decideApproval(input({ mode: 'ask-all', guard: purchase, savedRule: 'site' }))).toEqual({ kind: 'countdown', action: 'purchase', rule: 'site' })
    expect(decideApproval(input({ guard: payment, savedRule: 'site' }))).toMatchObject({ kind: 'ask', alwaysAsk: true })
  })

  it('an always-ask answer can only be remembered once', () => {
    expect(clampScope('site', ['once'])).toBe('once')
    expect(clampScope('chat', ['once', 'chat', 'site'])).toBe('chat')
  })
})

describe('guard action kinds', () => {
  it('marks payment and account-security actions as always asking', () => {
    expect([...ALWAYS_ASK].sort()).toEqual(['payment', 'security'])
    expect(guardAction({ kind: 'click', element: el({ name: 'Change password' }) })).toMatchObject({ action: 'security', alwaysAsk: true })
    expect(guardAction({ kind: 'click', element: el({ name: 'Turn on two-factor' }) })).toMatchObject({ action: 'security', alwaysAsk: true })
    expect(guardAction({ kind: 'click', element: el({ name: 'Pay now' }) })).toMatchObject({ action: 'payment', alwaysAsk: true })
    expect(guardAction({ kind: 'click', element: el({ name: 'Continue', formHasPaymentFields: true, inForm: true }) })).toMatchObject({ action: 'payment', alwaysAsk: true })
    expect(guardAction({ kind: 'enter', element: el({ role: 'textbox', tag: 'input', inForm: true, formHasPaymentFields: true }) })).toMatchObject({ action: 'payment', alwaysAsk: true })
  })

  it('classifies other consequential clicks without always asking', () => {
    expect(guardAction({ kind: 'click', element: el({ name: 'Buy now' }) })).toMatchObject({ action: 'purchase', alwaysAsk: false })
    expect(guardAction({ kind: 'click', element: el({ name: 'Send' }) })).toMatchObject({ action: 'message', alwaysAsk: false })
    expect(guardAction({ kind: 'click', element: el({ name: 'Delete' }) })).toMatchObject({ action: 'delete' })
    expect(guardAction({ kind: 'click', element: el({ name: 'Close account' }) })).toMatchObject({ action: 'account' })
    expect(guardAction({ kind: 'click', element: el({ name: 'Next page' }) })).toBeNull()
    expect(guardAction({ kind: 'enter', element: el({ role: 'textbox', tag: 'textarea', inForm: true }) })).toBeNull()
  })
})
