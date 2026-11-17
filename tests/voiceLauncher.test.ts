/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import type { SpeechBroker, SpeechSession, SpeechSessionEvent } from '../src/shared/speech'
import { closedLauncher, launcherKeyAction, reduceLauncher, type LauncherEvent } from '../src/main/voice/launcher'
import { LauncherShortcut, type ShortcutBackend } from '../src/main/voice/shortcut'
import { smokeVoiceBroker, voiceSmoke } from '../src/main/voice/smokeSpeech'

// The quick-ask launcher (MV-02, MV-03), its opt-in global shortcut that
// follows focus, and the smoke run's word seam.

const OPEN: LauncherEvent = { type: 'open', attach: true, screenshot: null, screenshotBlocked: false, chord: 'alt+space', sounds: true }

function run(events: LauncherEvent[], from = closedLauncher()) {
  return events.reduce(reduceLauncher, from)
}

describe('the launcher state machine', () => {
  it('opens listening, shows the live partial, then the final text', () => {
    let p = run([OPEN, { type: 'partial', text: 'what' }])
    expect(p).toMatchObject({ state: 'listening', partial: 'what', text: '', turn: 1 })
    p = run([{ type: 'final', text: 'what time is it' }], p)
    expect(p).toMatchObject({ text: 'what time is it', partial: '' })
  })

  it('stopping transcribes, then keeps an unfinalised partial for editing', () => {
    const p = run([OPEN, { type: 'final', text: 'book a table' }, { type: 'partial', text: 'for two' }, { type: 'stop' }])
    expect(p.state).toBe('transcribing')
    expect(run([{ type: 'stopped' }], p)).toMatchObject({ state: 'typing', text: 'book a table for two', partial: '' })
  })

  it('sends only non-empty text, then works until it hides', () => {
    const typing = run([OPEN, { type: 'type' }])
    expect(typing.state).toBe('typing')
    expect(reduceLauncher(typing, { type: 'send' }).state).toBe('typing')
    const sending = run([{ type: 'edit', text: 'hello' }, { type: 'send' }], typing)
    expect(sending.state).toBe('sending')
    expect(reduceLauncher(sending, { type: 'listen' })).toBe(sending)
    expect(reduceLauncher(sending, { type: 'sent' }).state).toBe('working')
  })

  it('remembers the screenshot chip only when there is a picture', () => {
    let p = run([OPEN])
    expect(p.attachScreenshot).toBe(false)
    p = reduceLauncher(p, { type: 'shot', screenshot: 'data:image/jpeg;base64,AA', blocked: false, attach: true })
    expect(p.attachScreenshot).toBe(true)
    expect(reduceLauncher(p, { type: 'attach', on: false }).attachScreenshot).toBe(false)
    const blocked = reduceLauncher(run([OPEN]), { type: 'shot', screenshot: null, blocked: true, attach: true })
    expect(blocked).toMatchObject({ screenshotBlocked: true, screenshotRelaunch: false, attachScreenshot: false })
  })

  it('offers a relaunch on the chip when Screen Recording is on but not in effect yet, and forgets it on the next opening', () => {
    const waiting = reduceLauncher(run([OPEN]), { type: 'shot', screenshot: null, blocked: true, relaunch: true, attach: true })
    expect(waiting).toMatchObject({ screenshotBlocked: true, screenshotRelaunch: true })
    // Only a blocked shot can wait for a relaunch.
    expect(reduceLauncher(waiting, { type: 'shot', screenshot: 'data:image/jpeg;base64,AA', blocked: false, relaunch: true, attach: true })).toMatchObject({ screenshotBlocked: false, screenshotRelaunch: false })
    expect(reduceLauncher(waiting, OPEN).screenshotRelaunch).toBe(false)
  })

  it('errors clear on editing or listening again, and each opening starts fresh', () => {
    const failed = run([OPEN, { type: 'final', text: 'hi' }, { type: 'error', code: 'mic-busy' }])
    expect(failed).toMatchObject({ state: 'error', error: 'mic-busy' })
    expect(reduceLauncher(failed, { type: 'edit', text: 'hi there' })).toMatchObject({ state: 'typing', error: null })
    expect(reduceLauncher(failed, { type: 'listen' })).toMatchObject({ state: 'listening', error: null, text: 'hi' })
    expect(reduceLauncher(failed, OPEN)).toMatchObject({ state: 'listening', text: '', error: null, turn: failed.turn + 1 })
  })

  it('the key opens, stops while listening, and hides otherwise', () => {
    const listening = run([OPEN])
    expect(launcherKeyAction(false, listening)).toBe('open')
    expect(launcherKeyAction(true, listening)).toBe('stop')
    expect(launcherKeyAction(true, { ...listening, state: 'typing' })).toBe('hide')
    expect(launcherKeyAction(true, { ...listening, state: 'working' })).toBe('hide')
  })
})

function backend(fail = false): ShortcutBackend & { held: Set<string>; register: ReturnType<typeof vi.fn> } {
  const held = new Set<string>()
  return {
    held,
    register: vi.fn((accelerator: string) => {
      if (fail) return false
      held.add(accelerator)
      return true
    }),
    unregister: (accelerator: string) => {
      held.delete(accelerator)
    },
  }
}

describe('the launcher’s global shortcut', () => {
  function setup(opts: { on?: boolean; focused?: boolean; smoke?: boolean; fail?: boolean } = {}) {
    const state = { on: opts.on ?? true, focused: opts.focused ?? false, accelerator: 'Alt+Space' }
    const b = backend(opts.fail)
    const onChange = vi.fn()
    const s = new LauncherShortcut({
      backend: b,
      wanted: () => ({ on: state.on, accelerator: state.accelerator }),
      atelierFocused: () => state.focused,
      onPress: () => undefined,
      smoke: opts.smoke ?? false,
      onChange,
    })
    return { s, b, state, onChange }
  }

  it('is registered only while no Atelier window has focus', () => {
    const { s, b, state } = setup({ focused: true })
    s.reconcile()
    expect(b.held.size).toBe(0)
    state.focused = false
    s.reconcile()
    expect([...b.held]).toEqual(['Alt+Space'])
    state.focused = true
    s.reconcile()
    expect(b.held.size).toBe(0)
  })

  it('follows the switch and the chord', () => {
    const { s, b, state } = setup()
    s.reconcile()
    state.accelerator = 'Control+Shift+Space'
    s.reconcile()
    expect([...b.held]).toEqual(['Control+Shift+Space'])
    state.on = false
    s.reconcile()
    expect(b.held.size).toBe(0)
    expect(s.status()).toEqual({ registered: false, conflict: false })
  })

  it('reports a conflict when another app holds the keys, and clears it when switched off', () => {
    const { s, state, onChange } = setup({ fail: true })
    s.reconcile()
    expect(s.status()).toEqual({ registered: false, conflict: true })
    expect(onChange).toHaveBeenCalledWith({ registered: false, conflict: true })
    state.on = false
    s.reconcile()
    expect(s.status().conflict).toBe(false)
  })

  it('a probe from Settings tries once without keeping the keys while Atelier has focus', () => {
    const { s, b } = setup({ focused: true })
    s.probe()
    expect(b.register).toHaveBeenCalledTimes(1)
    expect(b.held.size).toBe(0)
    expect(s.status()).toEqual({ registered: true, conflict: false })
  })

  it('is never registered under smoke, and lets go on quit', () => {
    const smoke = setup({ smoke: true })
    smoke.s.reconcile()
    smoke.s.probe()
    expect(smoke.b.register).not.toHaveBeenCalled()
    const live = setup()
    live.s.reconcile()
    live.s.dispose()
    expect(live.b.held.size).toBe(0)
  })
})

describe('the smoke word seam', () => {
  function fakeBroker(): { broker: SpeechBroker; emitted: SpeechSessionEvent[] } {
    const emitted: SpeechSessionEvent[] = []
    const session: SpeechSession = {
      id: 's1',
      purpose: 'voice-command',
      on: () => () => undefined,
      stop: async () => ({ durationMs: 0, audio: null }),
      pause: () => undefined,
      resume: () => undefined,
      cancel: () => undefined,
    }
    const broker = { begin: async (o: { purpose: string }) => ({ ...session, purpose: o.purpose }), status: () => ({ available: true }) } as unknown as SpeechBroker
    return { broker, emitted }
  }

  it('hands queued words to voice sessions only', async () => {
    vi.useFakeTimers()
    try {
      const { broker } = fakeBroker()
      const wrapped = smokeVoiceBroker(broker)
      voiceSmoke.say('hello there')
      const meeting = await wrapped.begin({ purpose: 'meeting', mode: 'meeting' } as never)
      const heardByMeeting: SpeechSessionEvent[] = []
      meeting.on((e) => heardByMeeting.push(e))
      const voice = await wrapped.begin({ purpose: 'voice-command', mode: 'dictation' } as never)
      const heard: SpeechSessionEvent[] = []
      voice.on((e) => heard.push(e))
      await vi.advanceTimersByTimeAsync(100)
      expect(heardByMeeting).toEqual([])
      expect(heard.map((e) => e.type)).toEqual(['partial', 'final'])
      expect(wrapped.status()).toEqual({ available: true })
    } finally {
      voiceSmoke.clear()
      vi.useRealTimers()
    }
  })
})
