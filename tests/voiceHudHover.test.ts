/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, BrowserWindow: { getFocusedWindow: () => null }, shell: {}, systemPreferences: {}, desktopCapturer: {} }))
vi.mock('../src/main/voice/platform', () => ({
  readFocus: vi.fn(async () => null),
  captureScreen: vi.fn(async () => null),
  captureTab: vi.fn(async () => null),
  insertText: vi.fn(async () => 'typed'),
  replaceFieldText: vi.fn(async () => 'typed'),
}))

import { COUNTDOWN } from '../src/main/voice/hud'
import { VoiceTurns } from '../src/main/voice/turns'

// A HUD closed while the pointer was on it (its close button) gets no
// mouseleave, so the hover pause must end with the HUD, not carry into the
// next one and keep it open for good.

function setup() {
  const closed: Array<(kind: string) => void> = []
  const open = new Set<string>()
  const float = {
    handle: () => () => undefined,
    on: (_event: string, fn: (kind: string) => void) => closed.push(fn),
    open: (kind: string) => open.add(kind),
    update: () => undefined,
    isOpen: (kind: string) => open.has(kind),
    close: (kind: string) => {
      if (open.delete(kind)) for (const fn of closed) fn(kind)
    },
    window: () => null,
  }
  const voice = { target: 'companion', sounds: false, chord: 'alt+space', voiceName: null, screenshot: false }
  const ctx = { float, settings: { get: () => ({ voice }) }, windows: { fromWebContents: () => null, all: () => [], focused: () => null } }
  // The broker refuses, so each hold ends in an error HUD with its countdown.
  const rt = {
    broker: () => ({ begin: async () => Promise.reject(new Error('no helper')) }),
    changed: () => undefined,
    noteBlocked: () => undefined,
  }
  const turns = new VoiceTurns(ctx as never, rt as never)
  const key = { wc: { id: 1, isDestroyed: () => false }, win: null }
  return { turns, key }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('voice HUD hover', () => {
  it('pauses the countdown while hovered', async () => {
    const { turns, key } = setup()
    turns.start(key as never, false)
    await settle()
    expect(turns.hud().state).toBe('error')
    expect(turns.hud().countdownMs).toBe(COUNTDOWN.error)
    turns.action('hover-start')
    expect(turns.hud().countdownMs).toBeNull()
    turns.dispose()
  })

  it('does not carry a hover into the next HUD after closing while hovered', async () => {
    const { turns, key } = setup()
    turns.start(key as never, false)
    await settle()
    turns.action('hover-start')
    turns.action('dismiss')
    turns.start(key as never, false)
    await settle()
    expect(turns.hud().state).toBe('error')
    expect(turns.hud().countdownMs).toBe(COUNTDOWN.error)
    turns.dispose()
  })
})
