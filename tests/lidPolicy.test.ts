/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { LidAction, LidPausedBy, LidPolicyEvent, LidRecordingState } from '../src/shared/haptics'
import { IDLE_CAPTURE, type CaptureState, type CaptureStatus } from '../src/shared/meetingCapture'
import type { HelperLine } from '../src/shared/speech'
import { LidPause, lidEventOf, lidPolicy, lidRecordingState } from '../src/main/native/lid'
import { nativeSmokeHooks, setupNative } from '../src/main/native/service'

// The lid-pause policy over every combination, the
// controller that remembers the lid, and the wiring to the capture broker, the
// recorder and powerMonitor.

const EVENTS: LidPolicyEvent[] = ['lid-closed', 'lid-opened', 'suspend', 'resume']
const RECORDING: LidRecordingState[] = ['none', 'recording', 'paused']
const PAUSED_BY: LidPausedBy[] = ['user', 'lid', null]

function expected(event: LidPolicyEvent, recording: LidRecordingState, pausedBy: LidPausedBy, enabled: boolean): LidAction {
  const closing = event === 'lid-closed' || event === 'suspend'
  if (closing) return enabled && recording === 'recording' ? 'pause' : 'none'
  return recording === 'paused' && pausedBy === 'lid' ? 'resume' : 'none'
}

describe('lidPolicy', () => {
  it('covers every combination', () => {
    let count = 0
    for (const event of EVENTS)
      for (const recording of RECORDING)
        for (const pausedBy of PAUSED_BY)
          for (const enabled of [true, false]) {
            expect(lidPolicy(event, recording, pausedBy, enabled), `${event} ${recording} ${pausedBy} ${enabled}`).toBe(expected(event, recording, pausedBy, enabled))
            count++
          }
    expect(count).toBe(72)
  })

  it('pauses a running recording when the lid closes or the computer sleeps', () => {
    expect(lidPolicy('lid-closed', 'recording', null, true)).toBe('pause')
    expect(lidPolicy('suspend', 'recording', null, true)).toBe('pause')
  })

  it('leaves everything alone with the setting off', () => {
    expect(lidPolicy('lid-closed', 'recording', null, false)).toBe('none')
    expect(lidPolicy('suspend', 'recording', null, false)).toBe('none')
  })

  it('resumes only a pause Atelier made, even if the setting was turned off meanwhile', () => {
    expect(lidPolicy('lid-opened', 'paused', 'lid', true)).toBe('resume')
    expect(lidPolicy('resume', 'paused', 'lid', false)).toBe('resume')
    expect(lidPolicy('lid-opened', 'paused', 'user', true)).toBe('none')
    expect(lidPolicy('lid-opened', 'recording', null, true)).toBe('none')
  })

  it('never pauses twice or touches a pause the person made', () => {
    expect(lidPolicy('lid-closed', 'paused', 'user', true)).toBe('none')
    expect(lidPolicy('suspend', 'paused', 'lid', true)).toBe('none')
  })
})

describe('lidRecordingState and lidEventOf', () => {
  it('maps capture states', () => {
    const states: CaptureState[] = ['idle', 'starting', 'recording', 'paused', 'stopping', 'processing']
    expect(states.map(lidRecordingState)).toEqual(['none', 'none', 'recording', 'paused', 'none', 'none'])
  })

  it('reads only lid lines', () => {
    expect(lidEventOf({ type: 'lid', closed: true })).toBe('lid-closed')
    expect(lidEventOf({ type: 'lid', closed: false })).toBe('lid-opened')
    expect(lidEventOf({ type: 'ready', version: 2 })).toBeNull()
    expect(lidEventOf({ type: 'paused', session: 's' })).toBeNull()
  })
})

/** A recorder that keeps pausedBy the way the meeting capture contract describes. */
function fakeRecorder(state: CaptureState = 'recording') {
  let status: CaptureStatus = { ...IDLE_CAPTURE, state, meetingId: state === 'idle' ? null : 'm1' }
  const calls: string[] = []
  return {
    calls,
    status: () => status,
    pause: (by: 'user' | 'lid' = 'user') => {
      calls.push(`pause:${by}`)
      if (status.state === 'recording') status = { ...status, state: 'paused', pausedBy: by }
    },
    resume: (by: 'user' | 'lid' = 'user') => {
      calls.push(`resume:${by}`)
      if (status.state === 'paused') status = { ...status, state: 'recording', pausedBy: null }
    },
    set: (s: Partial<CaptureStatus>) => {
      status = { ...status, ...s }
    },
  }
}

describe('LidPause', () => {
  const make = (state?: CaptureState, enabled = true) => {
    const recorder = fakeRecorder(state)
    let notices = 0
    const lid = new LidPause({ recorder, enabled: () => enabled, notifyPaused: () => void notices++ })
    return { recorder, lid, notices: () => notices }
  }

  it('pauses on close with a notice and resumes on open', () => {
    const { recorder, lid, notices } = make()
    expect(lid.line({ type: 'lid', closed: true })).toBe('pause')
    expect(recorder.status()).toMatchObject({ state: 'paused', pausedBy: 'lid' })
    expect(notices()).toBe(1)
    expect(lid.line({ type: 'lid', closed: false })).toBe('resume')
    expect(recorder.status()).toMatchObject({ state: 'recording', pausedBy: null })
    expect(recorder.calls).toEqual(['pause:lid', 'resume:lid'])
  })

  it('keeps a pause the person made when the lid opens', () => {
    const { recorder, lid } = make()
    recorder.pause('user')
    expect(lid.handle('lid-closed')).toBe('none')
    expect(lid.handle('lid-opened')).toBe('none')
    expect(recorder.status()).toMatchObject({ state: 'paused', pausedBy: 'user' })
  })

  it('waits for the lid to open when the computer wakes with it still shut', () => {
    const { recorder, lid } = make()
    lid.handle('lid-closed')
    expect(lid.handle('suspend')).toBe('none')
    expect(lid.handle('resume')).toBe('none')
    expect(recorder.status().state).toBe('paused')
    expect(lid.handle('lid-opened')).toBe('resume')
  })

  it('pauses on sleep and resumes on wake when no lid line came', () => {
    const { recorder, lid } = make()
    expect(lid.handle('suspend')).toBe('pause')
    expect(lid.handle('resume')).toBe('resume')
    expect(recorder.calls).toEqual(['pause:lid', 'resume:lid'])
  })

  it('does nothing without a recording or with the setting off', () => {
    const idle = make('idle')
    expect(idle.lid.handle('lid-closed')).toBe('none')
    expect(idle.recorder.calls).toEqual([])
    const off = make('recording', false)
    expect(off.lid.handle('lid-closed')).toBe('none')
    expect(off.notices()).toBe(0)
  })

  it('ignores every other helper line', () => {
    const { recorder, lid } = make()
    const lines: HelperLine[] = [{ type: 'paused', session: 's' }, { type: 'ready', version: 2 }]
    for (const line of lines) expect(lid.line(line)).toBe('none')
    expect(recorder.calls).toEqual([])
  })
})

describe('setupNative lid wiring', () => {
  function rig(enabled = true, platform: NodeJS.Platform = 'darwin') {
    const recorder = fakeRecorder()
    let lineListener: ((l: HelperLine) => void) | null = null
    const power = new Map<string, () => void>()
    const notices: Array<{ title: string; category: string }> = []
    const native = setupNative({
      settings: { get: () => ({ haptics: true, pauseMeetingsOnLidClose: enabled }) } as never,
      broker: {
        onLine: (fn: (l: HelperLine) => void) => {
          lineListener = fn
          return () => {
            lineListener = null
          }
        },
      } as never,
      recorder: recorder as never,
      notify: (n) => void notices.push(n),
      power: { on: (e, fn) => power.set(e, fn), off: (e) => power.delete(e) },
      platform,
    })
    return { recorder, native, notices, power, send: (l: HelperLine) => lineListener?.(l), listening: () => lineListener !== null }
  }

  it('pauses through the broker line and resumes on the open line', () => {
    const { recorder, native, notices, send } = rig()
    send({ type: 'lid', closed: true })
    expect(recorder.status()).toMatchObject({ state: 'paused', pausedBy: 'lid' })
    expect(notices).toEqual([expect.objectContaining({ category: 'meetings', title: 'Paused while the lid is closed' })])
    send({ type: 'lid', closed: false })
    expect(recorder.status().state).toBe('recording')
    native.dispose()
  })

  it('pauses on powerMonitor suspend and words the notice as sleep off macOS', () => {
    const { recorder, native, notices, power } = rig(true, 'win32')
    power.get('suspend')?.()
    expect(recorder.status().pausedBy).toBe('lid')
    expect(notices[0]?.title).toBe('Paused while the computer sleeps')
    power.get('resume')?.()
    expect(recorder.status().state).toBe('recording')
    native.dispose()
  })

  it('exposes the same handlers to smoke, and unhooks everything on dispose', () => {
    const { recorder, native, power, listening } = rig()
    expect(nativeSmokeHooks()?.line({ type: 'lid', closed: true })).toBe('pause')
    expect(nativeSmokeHooks()?.power('resume')).toBe('none')
    expect(recorder.status().state).toBe('paused')
    native.dispose()
    expect(listening()).toBe(false)
    expect(power.size).toBe(0)
    expect(nativeSmokeHooks()).toBeNull()
  })

  it('still starts when the broker or recorder is not filled yet', () => {
    const throwing = new Proxy({}, { get: () => () => { throw new Error('Not available yet') } })
    const native = setupNative({ settings: { get: () => ({ haptics: true, pauseMeetingsOnLidClose: true }) } as never, broker: throwing as never, recorder: throwing as never })
    expect(nativeSmokeHooks()?.power('suspend')).toBe('none')
    native.dispose()
  })
})
