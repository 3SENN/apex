/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn(async () => ({ response: 1, checkboxChecked: false })) } }))

import type { DialogResult, DialogSpec } from '@shared/dialogs'
import { alertSpec, buttonRows, confirmSpec, enterButton, escapeButton, initialFocus, keyAction, resultFor } from '@shared/dialogLogic'
import { DialogQueue } from '../src/main/dialogQueue'
import { cancelResult, confirmButton, dialogs } from '../src/main/dialogs'
import type { WindowContext } from '../src/main/features/types'

// OV-07, OV-08: one dialog at a time per window, a queue, duplicates by
// dedupeKey dropped onto the one already there, Esc/close/backdrop as cancel,
// tab dialogs that wait for their tab, the timeout and the plain fallback.

const confirmLike = (dedupeKey?: string): DialogSpec => confirmSpec({ title: 'Delete it?', confirmLabel: 'Delete', cancelLabel: 'Cancel', destructive: true, ...(dedupeKey ? { dedupeKey } : {}) })

describe('DialogQueue', () => {
  it('starts one dialog at a time, in order', () => {
    const q = new DialogQueue<string>()
    q.push({ id: 'a', tabId: null, payload: 'a' })
    q.push({ id: 'b', tabId: null, payload: 'b' })
    expect(q.next([])?.id).toBe('a')
    expect(q.next([])).toBeNull()
    q.remove('a')
    expect(q.next([])?.id).toBe('b')
  })

  it('drops a duplicate onto the one waiting or showing', () => {
    const q = new DialogQueue<string>()
    expect(q.push({ id: 'a', tabId: null, dedupeKey: 'k', payload: 'a' })).toEqual({ accepted: true })
    expect(q.push({ id: 'b', tabId: null, dedupeKey: 'k', payload: 'b' })).toEqual({ accepted: false, sameAs: 'a' })
    q.next([])
    expect(q.push({ id: 'c', tabId: null, dedupeKey: 'k', payload: 'c' })).toEqual({ accepted: false, sameAs: 'a' })
    expect(q.push({ id: 'd', tabId: null, dedupeKey: 'other', payload: 'd' })).toEqual({ accepted: true })
    expect(q.size).toBe(2)
  })

  it('keeps a tab dialog waiting until its tab is on screen, without holding up the window', () => {
    const q = new DialogQueue<string>()
    q.push({ id: 'page', tabId: 't2', payload: 'page' })
    q.push({ id: 'win', tabId: null, payload: 'win' })
    expect(q.next(['t1'])?.id).toBe('win')
    q.remove('win')
    expect(q.next(['t1'])).toBeNull()
    expect(q.next(['t2'])?.id).toBe('page')
  })

  it('lets a window dialog start while a started tab dialog is hidden', () => {
    const q = new DialogQueue<string>()
    q.push({ id: 'page', tabId: 't1', payload: 'page' })
    expect(q.next(['t1'])?.id).toBe('page')
    q.push({ id: 'win', tabId: null, payload: 'win' })
    expect(q.next(['t1'])).toBeNull()
    expect(q.next(['t2'])?.id).toBe('win')
    expect(q.isActive('page')).toBe(true)
  })

  it('lists a tab’s dialogs, started first, and removes waiting ones', () => {
    const q = new DialogQueue<string>()
    q.push({ id: 'a', tabId: 't1', payload: 'a' })
    q.push({ id: 'b', tabId: 't1', payload: 'b' })
    q.next(['t1'])
    expect(q.forTab('t1').map((d) => d.id)).toEqual(['a', 'b'])
    expect(q.remove('b')?.id).toBe('b')
    expect(q.remove('missing')).toBeNull()
  })
})

describe('dialog logic', () => {
  const spec: DialogSpec = {
    title: 'Sign in',
    inputs: [{ id: 'user', label: 'User', type: 'text', value: 'ann' }],
    checkbox: { label: 'Remember', checked: true },
    buttons: [
      { id: 'help', label: 'Help', style: 'link', align: 'start' },
      { id: 'cancel', label: 'Cancel', style: 'secondary', escape: true },
      { id: 'ok', label: 'Sign In', style: 'primary', enter: true },
    ],
  }

  it('finds the Enter and Esc buttons and the sides', () => {
    expect(enterButton(spec)?.id).toBe('ok')
    expect(escapeButton(spec)?.id).toBe('cancel')
    expect(buttonRows(spec).start.map((b) => b.id)).toEqual(['help'])
    expect(buttonRows(spec).end.map((b) => b.id)).toEqual(['cancel', 'ok'])
  })

  it('answers Enter in a field but leaves Enter on a button to the button', () => {
    expect(keyAction(spec, 'Enter', { tag: 'INPUT', type: 'text' })?.press?.id).toBe('ok')
    expect(keyAction(spec, 'Enter', { tag: 'BUTTON' })).toBeNull()
    expect(keyAction(spec, 'Escape', { tag: 'BUTTON' })?.press?.id).toBe('cancel')
    expect(keyAction(spec, 'a', { tag: 'INPUT' })).toBeNull()
  })

  it('focuses the first field, or Cancel when the action is destructive', () => {
    expect(initialFocus(spec)).toEqual({ kind: 'input', id: 'user' })
    expect(initialFocus(confirmLike())).toEqual({ kind: 'button', id: 'cancel' })
    expect(initialFocus(confirmSpec({ title: 'Go?', confirmLabel: 'Go', cancelLabel: 'No' }))).toEqual({ kind: 'button', id: 'confirm' })
  })

  it('keeps only the spec’s inputs and its checkbox in a result', () => {
    expect(resultFor(spec, enterButton(spec), { user: 'bo', extra: 'x' }, false)).toEqual({ button: 'ok', inputs: { user: 'bo' }, checked: false })
    expect(resultFor(alertSpec({ title: 'Hi', okLabel: 'OK' }), null, {}, true)).toEqual({ button: null, inputs: {}, checked: false })
  })

  it('treats cancel as the Esc button and confirm as the Enter one', () => {
    expect(cancelResult(confirmLike())).toEqual({ button: 'cancel', inputs: {}, checked: false })
    expect(confirmButton(confirmLike())).toBe('confirm')
    expect(cancelResult({ title: 'x', buttons: [{ id: 'ok', label: 'OK', style: 'primary' }] }).button).toBeNull()
  })
})

// A window just real enough for main's presenter.
interface FakeOverlay {
  opens: { surface: string; props: unknown; instanceId: string; resolve(r: unknown): void; reject(e: unknown): void }[]
  closed: string[]
  fail: boolean
}

function fakeWindow(): { win: WindowContext; overlay: FakeOverlay; sent: unknown[]; tabs: EventEmitter & { visible: string[] }; window: EventEmitter } {
  const overlay: FakeOverlay = { opens: [], closed: [], fail: false }
  const sent: unknown[] = []
  const tabs = Object.assign(new EventEmitter(), { visible: ['t1'] })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }) })
  let seq = 0
  const win = {
    id: Math.floor(Math.random() * 1e9),
    window,
    chrome: { isDestroyed: () => false, isCrashed: () => false, getZoomFactor: () => 1 },
    tabs: Object.assign(tabs, {
      visibleIds: () => tabs.visible,
      paneBounds: (id: string) => (tabs.visible.includes(id) ? { x: 0, y: 40, width: 800, height: 600 } : null),
      activeId: () => tabs.visible[0] ?? null,
    }),
    overlay: {
      openSurfaces: () => overlay.opens.map((o) => ({ instanceId: o.instanceId, surface: o.surface })),
      open: (surface: string, _anchor: unknown, props: unknown) => {
        if (overlay.fail) throw new Error('no overlay')
        return new Promise((resolve, reject) => overlay.opens.push({ surface, props, instanceId: `i${++seq}`, resolve, reject }))
      },
      close: (id: string) => overlay.closed.push(id),
      update: () => undefined,
    },
    send: (e: unknown) => sent.push(e),
  } as unknown as WindowContext
  return { win, overlay, sent, tabs, window }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('main dialogs', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows one at a time and the next when the first is answered', async () => {
    const { win, overlay } = fakeWindow()
    const first = dialogs.show(win, confirmLike())
    const second = dialogs.show(win, alertSpec({ title: 'Done', okLabel: 'OK' }))
    await flush()
    expect(overlay.opens).toHaveLength(1)
    overlay.opens[0]!.resolve({ instanceId: 'i1', value: { button: 'confirm', inputs: {}, checked: false } })
    expect(await first).toEqual({ button: 'confirm', inputs: {}, checked: false })
    await flush()
    expect(overlay.opens).toHaveLength(2)
    overlay.opens[1]!.resolve({ instanceId: 'i2', dismissed: 'escape' })
    expect((await second).button).toBe('ok')
  })

  it('drops a duplicate and gives both callers the one answer', async () => {
    const { win, overlay } = fakeWindow()
    const a = dialogs.confirm(win, confirmLike('same'))
    const b = dialogs.confirm(win, confirmLike('same'))
    await flush()
    expect(overlay.opens).toHaveLength(1)
    overlay.opens[0]!.resolve({ instanceId: 'i1', value: { button: 'confirm', inputs: {}, checked: false } })
    expect(await a).toBe(true)
    expect(await b).toBe(true)
  })

  it('counts Esc, an outside press and close as cancel, and ignores unknown buttons', async () => {
    const { win, overlay } = fakeWindow()
    for (const dismissed of ['escape', 'outside', 'closed'] as const) {
      const p = dialogs.confirm(win, confirmLike())
      await flush()
      overlay.opens.at(-1)!.resolve({ instanceId: 'x', dismissed })
      expect(await p).toBe(false)
    }
    const forged = dialogs.show(win, confirmLike())
    await flush()
    overlay.opens.at(-1)!.resolve({ instanceId: 'x', value: { button: 'evil', inputs: { other: '1' }, checked: true } })
    expect(await forged).toEqual({ button: null, inputs: {}, checked: false })
  })

  it('cancels a page dialog after its timeout and closes the surface', async () => {
    const { win, overlay } = fakeWindow()
    const handle = dialogs.open(win, confirmLike(), { tabId: 't1', timeoutMs: 1000 })
    await flush()
    expect(overlay.opens).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(await handle.result).toEqual({ button: null, inputs: {}, checked: false })
    expect(overlay.closed).toContain('i1')
  })

  it('cancels a tab’s dialogs when the tab closes', async () => {
    const { win, tabs } = fakeWindow()
    const p = dialogs.show(win, confirmLike(), { tabId: 't1' })
    await flush()
    tabs.emit('closed', { id: 't1' })
    expect((await p).button).toBeNull()
    expect(dialogs.pendingFor(win, 't1')).toBe(false)
  })

  it('waits with a background tab’s dialog until the tab is shown', async () => {
    const { win, overlay, tabs } = fakeWindow()
    void dialogs.show(win, confirmLike(), { tabId: 't2' })
    await flush()
    expect(overlay.opens).toHaveLength(0)
    expect(dialogs.pendingFor(win, 't2')).toBe(true)
    tabs.visible = ['t2']
    tabs.emit('activated')
    await flush()
    expect(overlay.opens).toHaveLength(1)
  })

  it('closes a closeOnBlur tab dialog as cancel when the window loses focus', async () => {
    const { win, window } = fakeWindow()
    const p = dialogs.show(win, confirmLike(), { tabId: 't1', closeOnBlur: true })
    await flush()
    window.emit('blur')
    expect((await p).button).toBe('cancel')
  })

  it('falls back to the chrome when the overlay can’t draw, and takes its answer', async () => {
    const { win, overlay, sent } = fakeWindow()
    overlay.fail = true
    const p = dialogs.show(win, confirmLike())
    await flush()
    const event = sent.find((e) => (e as { type: string }).type === 'dialog-fallback') as { id: string } | undefined
    expect(event).toBeDefined()
    dialogs.answer(win, event!.id, { button: 'confirm', inputs: {}, checked: false } satisfies DialogResult)
    expect((await p).button).toBe('confirm')
  })

  it('falls back when the surface crashes, and rejects chrome-opened dialogs instead', async () => {
    const { win, overlay, sent } = fakeWindow()
    const p = dialogs.show(win, confirmLike())
    await flush()
    overlay.opens[0]!.resolve({ instanceId: 'i1', dismissed: 'crashed' })
    await flush()
    expect(sent.some((e) => (e as { type: string }).type === 'dialog-fallback')).toBe(true)
    void p
    const fromChrome = dialogs.open(win, alertSpec({ title: 'x', okLabel: 'OK' }), {}, { fromChrome: true })
    // The first is still waiting in the chrome; answer it so the second can start.
    dialogs.answer(win, (sent[0] as { id: string }).id, { button: 'cancel', inputs: {}, checked: false })
    await flush()
    overlay.opens.at(-1)!.resolve({ instanceId: 'i2', dismissed: 'crashed' })
    await expect(fromChrome.result).rejects.toThrow()
  })
})
