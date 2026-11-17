/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/log', () => ({ log: { info: () => undefined, warn: () => undefined } }))

import { sessionEndHub } from '../src/main/system/sessionEnd'

// Windows ending the session (shut down, restart, sign out) sends no
// before-quit or will-quit, so quitting's saves run from the windows'
// 'session-end' instead: each once, the diagnostics' clean-exit marker last.

describe('session end (Windows shut down, restart, sign out)', () => {
  it('runs each handler once, the last ones after the rest, and goes on past one that throws', () => {
    const warn = vi.fn()
    const hub = sessionEndHub(warn)
    const ran: string[] = []
    hub.on(() => ran.push('marker'), { last: true })
    hub.on(() => ran.push('session'))
    hub.on(() => {
      throw new Error('disk full')
    })
    hub.on(() => ran.push('history'))
    hub.end()
    // A second window's session-end changes nothing.
    hub.end()
    expect(ran).toEqual(['session', 'history', 'marker'])
    expect(warn).toHaveBeenCalledWith('A session-end step failed', { error: 'disk full' })
  })

  it('leaves out a handler that was taken back', () => {
    const hub = sessionEndHub()
    const ran: string[] = []
    const off = hub.on(() => ran.push('recording'))
    hub.on(() => ran.push('session'))
    off()
    hub.end()
    expect(ran).toEqual(['session'])
  })
})
