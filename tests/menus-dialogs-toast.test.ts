/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }))

import { TOAST_ACTION_MS, TOAST_ERROR_MS, TOAST_MS, TOAST_TWO_LINE_MS, toastTiming } from '@shared/toastTiming'
import { toasts } from '../src/main/dialogs'
import type { WindowContext } from '../src/main/features/types'
import { confirmOptionsSpec, isToastOutcome, reasonFor, toastWire } from '../src/renderer/src/ui/logic/queues'

// OV-05: toasts at the top centre of the tab for about 2 s, longer
// with something to press or read; Undo runs only when pressed; the chrome's
// kit toasts and confirms cross to the overlay as plain data.

describe('toast timing', () => {
  it('stays about two seconds, longer for two lines, errors and actions', () => {
    expect(toastTiming({ kind: 'success' })).toBe(TOAST_MS)
    expect(TOAST_MS).toBeGreaterThanOrEqual(1500)
    expect(TOAST_MS).toBeLessThanOrEqual(2500)
    expect(toastTiming({ kind: 'info', detail: 'second line' })).toBe(TOAST_TWO_LINE_MS)
    expect(toastTiming({ kind: 'error' })).toBe(TOAST_ERROR_MS)
    expect(toastTiming({ kind: 'success', undo: true })).toBe(TOAST_ACTION_MS)
    expect(toastTiming({ kind: 'success', action: { id: 'a', label: 'Show' } })).toBe(TOAST_ACTION_MS)
    expect(toastTiming({ kind: 'success', durationMs: 0 })).toBe(0)
  })
})

function fakeWindow(): { win: WindowContext; opens: { props: unknown; resolve(r: unknown): void }[]; sent: unknown[]; updates: unknown[]; failNext: { on: boolean } } {
  const opens: { props: unknown; resolve(r: unknown): void }[] = []
  const sent: unknown[] = []
  const updates: unknown[] = []
  const failNext = { on: false }
  const win = {
    id: Math.floor(Math.random() * 1e9),
    window: { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }) },
    chrome: { isDestroyed: () => false, getZoomFactor: () => 1 },
    tabs: { activeId: () => 't1', paneBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
    overlay: {
      openSurfaces: () => opens.map((_, i) => ({ instanceId: `i${i + 1}`, surface: 'toast' })),
      open: (_s: string, _a: unknown, props: unknown) => {
        if (failNext.on) throw new Error('no overlay')
        return new Promise((resolve) => opens.push({ props, resolve }))
      },
      update: (_id: string, props: unknown) => updates.push(props),
      close: () => undefined,
    },
    send: (e: unknown) => sent.push(e),
  } as unknown as WindowContext
  return { win, opens, sent, updates, failNext }
}

describe('main toasts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('centres in the active tab and runs Undo only when pressed', async () => {
    const { win, opens } = fakeWindow()
    const undo = vi.fn()
    const shown = toasts.show(win, { kind: 'success', text: 'Chat deleted', undo })
    const props = opens[0]!.props as { toast: { undo?: boolean; tabId?: string }; area: unknown }
    expect(props.toast.undo).toBe(true)
    expect(props.toast.tabId).toBe('t1')
    opens[0]!.resolve({ instanceId: 'i1', value: 'undo' })
    expect(await shown).toBe('undo')
    await Promise.resolve()
    expect(undo).toHaveBeenCalledOnce()

    const undo2 = vi.fn()
    const timedOut = toasts.show(win, { kind: 'success', text: 'Deleted', undo: undo2 })
    opens[1]!.resolve({ instanceId: 'i2', value: 'timeout' })
    expect(await timedOut).toBe('timeout')
    expect(undo2).not.toHaveBeenCalled()
  })

  it('reports a tab switch and replaces a toast with the same id in place', async () => {
    const { win, opens, updates } = fakeWindow()
    const first = toasts.showFromChrome(win, { id: 'save', kind: 'info', text: 'Saving…' })
    const second = toasts.showFromChrome(win, { id: 'save', kind: 'success', text: 'Saved' })
    expect(opens).toHaveLength(1)
    expect(updates).toHaveLength(1)
    opens[0]!.resolve({ instanceId: 'i1', dismissed: 'tab-switch' })
    expect(await second).toBe('tab-switch')
    expect(await first).toBe('replaced')
  })

  it('falls back to the chrome’s toast and takes its outcome', async () => {
    const { win, sent, failNext } = fakeWindow()
    failNext.on = true
    const shown = toasts.show(win, { kind: 'error', text: 'It failed' })
    const event = sent[0] as { type: string; toast: { id: string } }
    expect(event.type).toBe('toast-fallback')
    toasts.outcome(event.toast.id, 'closed')
    expect(await shown).toBe('closed')
  })

  it('rejects a chrome toast the overlay can’t draw, so the chrome shows it itself', async () => {
    const { win, failNext } = fakeWindow()
    failNext.on = true
    await expect(toasts.showFromChrome(win, { kind: 'info', text: 'Hi' })).rejects.toThrow()
  })
})

describe('kit routing', () => {
  it('sends plain toasts to the overlay and keeps rich ones in the chrome', () => {
    expect(toastWire({ id: 't', message: 'Copied', tone: 'success' })).toEqual({ id: 't', kind: 'success', text: 'Copied' })
    expect(toastWire({ id: 't', message: 'Gone', tone: 'neutral', undo: () => undefined, action: { label: 'Open' }, duration: 0 })).toEqual({
      id: 't',
      kind: 'info',
      text: 'Gone',
      undo: true,
      action: { id: 'action', label: 'Open' },
      durationMs: 0,
    })
    expect(toastWire({ id: 't', message: { type: 'span' } })).toBeNull()
    expect(toastWire({ id: 't', message: '   ' })).toBeNull()
    expect(toastWire({ id: 't', message: 'x'.repeat(501) })).toBeNull()
  })

  it('maps the overlay’s outcomes to the kit’s reasons', () => {
    expect(reasonFor('tab-switch')).toBe('closed')
    expect(reasonFor('undo')).toBe('undo')
    expect(isToastOutcome('timeout')).toBe(true)
    expect(isToastOutcome(undefined)).toBe(false)
    expect(isToastOutcome('nope')).toBe(false)
  })

  it('turns a confirm into a deduped spec, unless its message is rich', () => {
    const spec = confirmOptionsSpec({ title: 'Delete /notes?', message: 'It goes.', destructive: true })!
    expect(spec.title).toBe('Delete /notes?')
    expect(spec.description).toBe('It goes.')
    expect(spec.icon).toBe('danger')
    expect(spec.buttons.map((b) => [b.id, b.style])).toEqual([
      ['cancel', 'secondary'],
      ['confirm', 'destructive'],
    ])
    expect(spec.dedupeKey).toBe('chrome:Delete /notes?:It goes.')
    expect(confirmOptionsSpec({ title: 'Go?', confirmLabel: 'Go' })!.buttons[1]).toMatchObject({ label: 'Go', style: 'primary' })
    expect(confirmOptionsSpec({ title: 'x', message: { rich: true } })).toBeNull()
  })
})
