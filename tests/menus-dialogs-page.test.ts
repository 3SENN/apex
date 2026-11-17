/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { INTENT_MAX_AGE_MS, SKIP_WINDOW_MS, allowNext, consumeSkip, isReload, newLeaveState, pickIntent, record, redoPlan } from '../src/main/leaveIntent'
import {
  BURST_LIMIT,
  BURST_WINDOW_MS,
  MESSAGE_SHOWN_MAX,
  PAGE_DIALOG_TIMEOUT_MS,
  agentNote,
  cancelReply,
  decide,
  documentChanged,
  newTabDialogState,
  pageDialogSpec,
  replyFor,
  siteLabel,
} from '../src/main/pageDialogPolicy'

// OV-08 page dialogs (alert, confirm, prompt) "Leave this page?".

describe('page dialog policy', () => {
  it('shows the first dialog plainly and offers to stop the site from the second', () => {
    const s = newTabDialogState()
    expect(decide(s, 'https://a.test', 0)).toEqual({ kind: 'show', offerStop: false })
    expect(decide(s, 'https://a.test', 10)).toEqual({ kind: 'show', offerStop: true })
  })

  it('blocks a burst, and lets dialogs through again once it has passed', () => {
    const s = newTabDialogState()
    for (let i = 0; i < BURST_LIMIT; i++) expect(decide(s, 'https://a.test', i).kind).toBe('show')
    expect(decide(s, 'https://a.test', BURST_LIMIT).kind).toBe('block')
    expect(decide(s, 'https://a.test', BURST_WINDOW_MS + BURST_LIMIT).kind).toBe('show')
  })

  it('keeps a stopped site stopped across documents, and counts again on a new document', () => {
    const s = newTabDialogState()
    decide(s, 'https://a.test', 0)
    s.blocked.add('https://a.test')
    expect(decide(s, 'https://a.test', 1).kind).toBe('block')
    documentChanged(s)
    expect(decide(s, 'https://a.test', 2).kind).toBe('block')
    expect(decide(s, 'https://b.test', 3)).toEqual({ kind: 'show', offerStop: false })
  })

  it('answers the page: cancel, confirm, prompt and alert', () => {
    expect(cancelReply('confirm')).toBe(false)
    expect(cancelReply('prompt')).toBeNull()
    expect(cancelReply('alert')).toBeNull()
    expect(replyFor('confirm', 'ok', undefined)).toBe(true)
    expect(replyFor('confirm', 'cancel', undefined)).toBe(false)
    expect(replyFor('confirm', null, undefined)).toBe(false)
    expect(replyFor('prompt', 'ok', 'hi')).toBe('hi')
    expect(replyFor('prompt', 'ok', undefined)).toBe('')
    expect(replyFor('prompt', 'cancel', 'hi')).toBeNull()
    expect(replyFor('alert', 'ok', undefined)).toBeNull()
  })

  it('names the site in the title so a page can’t pose as Atelier', () => {
    expect(siteLabel('https://www.example.com')).toBe('example.com')
    expect(siteLabel('data:text/html,x')).toBeNull()
    const confirm = pageDialogSpec({ kind: 'confirm', message: 'Sure?' }, 'https://example.com', false)
    expect(confirm.title).toContain('example.com')
    expect(confirm.description).toBe('Sure?')
    expect(confirm.buttons.map((b) => b.id)).toEqual(['cancel', 'ok'])
    expect(confirm.checkbox).toBeUndefined()
    const opaque = pageDialogSpec({ kind: 'alert', message: '' }, 'null', true)
    expect(opaque.title).not.toContain('null')
    expect(opaque.buttons).toHaveLength(1)
    expect(opaque.buttons[0]).toMatchObject({ id: 'ok', enter: true, escape: true })
    expect(opaque.checkbox?.checked).toBe(false)
  })

  it('gives a prompt its field and shortens huge messages', () => {
    const prompt = pageDialogSpec({ kind: 'prompt', message: 'x'.repeat(MESSAGE_SHOWN_MAX + 50), defaultValue: 'd' }, 'https://a.test', false)
    expect(prompt.inputs?.[0]).toMatchObject({ id: 'value', type: 'text', value: 'd' })
    expect(prompt.description!.length).toBe(MESSAGE_SHOWN_MAX + 1)
  })

  it('tells the agent about a dialog and asks it to check with the person first', () => {
    const note = agentNote({ kind: 'confirm', message: 'Delete account?' }, 'https://a.test')
    expect(note).toContain('a.test')
    expect(note).toContain('confirm')
    expect(note).toMatch(/ask them/i)
  })

  it('times out an unanswered dialog within minutes, not never', () => {
    expect(PAGE_DIALOG_TIMEOUT_MS).toBeGreaterThan(10_000)
    expect(PAGE_DIALOG_TIMEOUT_MS).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('Leave this page? redo', () => {
  it('uses only a recent intent', () => {
    const s = newLeaveState()
    record(s, { kind: 'load', url: 'https://b.test', at: 1000 })
    expect(pickIntent(s, 1000 + INTENT_MAX_AGE_MS)?.kind).toBe('load')
    expect(pickIntent(s, 1001 + INTENT_MAX_AGE_MS)).toBeNull()
  })

  it('spends the one-shot skip once, inside its window', () => {
    const s = newLeaveState()
    expect(consumeSkip(s, 0)).toBe(false)
    allowNext(s, 100)
    expect(consumeSkip(s, 100 + SKIP_WINDOW_MS)).toBe(true)
    expect(consumeSkip(s, 100 + SKIP_WINDOW_MS)).toBe(false)
    allowNext(s, 0)
    expect(consumeSkip(s, SKIP_WINDOW_MS + 1)).toBe(false)
  })

  it('replays navigations, reloads, history moves and closes, but not form posts', () => {
    expect(redoPlan({ kind: 'load', url: 'https://b.test', at: 0 })).toEqual({ kind: 'replay', intent: { kind: 'load', url: 'https://b.test', at: 0 } })
    expect(redoPlan({ kind: 'history', offset: -1, at: 0 }).kind).toBe('replay')
    expect(redoPlan({ kind: 'close', at: 0 }).kind).toBe('replay')
    expect(redoPlan({ kind: 'page', url: 'https://b.test', form: false, at: 0 }).kind).toBe('replay')
    expect(redoPlan({ kind: 'page', url: 'https://b.test', form: true, at: 0 })).toEqual({ kind: 'again', reason: 'form' })
    expect(redoPlan(null)).toEqual({ kind: 'again', reason: 'unknown' })
  })

  it('words a reload differently', () => {
    expect(isReload({ kind: 'reload', ignoreCache: false, at: 0 })).toBe(true)
    expect(isReload({ kind: 'load', url: 'x', at: 0 })).toBe(false)
    expect(isReload(null)).toBe(false)
  })
})
