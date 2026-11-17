/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import {
  activityKey,
  activityProp,
  clampPosition,
  isChallengeFrame,
  isChallengePage,
  kindFromLabel,
  movedPosition,
  noticeAnchorRect,
  pillState,
  reduceControl,
  shieldShown,
  toolKindOf,
  type AgentControlView,
  type ControlMap,
} from '../src/shared/agentControl'
import { AgentControl, type AgentControlHost } from '../src/main/agentControl'
import type { ControlSignal } from '../src/main/agent/host'
import type { AppEvent } from '../src/shared/services'
import { actionCall, noticeContent, pillText } from '../src/renderer/src/overlay/surfaces/chat/logic'

const empty: ControlMap = new Map()
const claim = (map: ControlMap, tabId: string, chatId = 'c1'): ControlMap => reduceControl(map, { type: 'claim', tabId, chatId, companionId: 'pip' })
const stateOf = (map: ControlMap, tabId: string): string | undefined => map.get(tabId)?.state

describe('agent control transitions', () => {
  it('claims start driving and releases end it', () => {
    const a = claim(empty, 't1')
    expect(stateOf(a, 't1')).toBe('driving')
    expect(claim(a, 't1')).toBe(a)
    expect(reduceControl(a, { type: 'release', tabId: 't1' }).size).toBe(0)
  })

  it('a claim by another chat keeps the notice where it was put', () => {
    let m = claim(empty, 't1')
    m = reduceControl(m, { type: 'move', tabId: 't1', position: { x: 300, y: 40 } })
    m = claim(m, 't1', 'c2')
    expect(m.get('t1')).toMatchObject({ chatId: 'c2', state: 'driving', position: { x: 300, y: 40 } })
  })

  it('taking over pauses the chat’s other tabs; handing back resumes them all', () => {
    let m = claim(claim(empty, 't1'), 't2')
    m = reduceControl(m, { type: 'take-over', tabId: 't1' })
    expect(stateOf(m, 't1')).toBe('taken-over')
    expect(stateOf(m, 't2')).toBe('paused')
    m = reduceControl(m, { type: 'hand-back', tabId: 't1' })
    expect(stateOf(m, 't1')).toBe('resuming')
    expect(stateOf(m, 't2')).toBe('resuming')
    m = reduceControl(m, { type: 'activity', chatId: 'c1', activity: 'Reading the page', started: true })
    expect(stateOf(m, 't1')).toBe('driving')
    expect(m.get('t2')?.activity).toBe('Reading the page')
  })

  it('a resume from elsewhere leaves a tab the person holds alone', () => {
    let m = claim(claim(empty, 't1'), 't2')
    m = reduceControl(m, { type: 'take-over', tabId: 't1' })
    m = reduceControl(m, { type: 'resume', chatId: 'c1' })
    expect(stateOf(m, 't1')).toBe('taken-over')
    expect(stateOf(m, 't2')).toBe('resuming')
  })

  it('a challenge waits for the person, then confirms and settles', () => {
    let m = claim(empty, 't1')
    m = reduceControl(m, { type: 'challenge', tabId: 't1' })
    expect(stateOf(m, 't1')).toBe('challenge')
    expect(shieldShown('challenge')).toBe(false)
    m = reduceControl(m, { type: 'challenge-done', tabId: 't1', at: 1000 })
    expect(m.get('t1')).toMatchObject({ state: 'resuming', solvedAt: 1000 })
    expect(shieldShown('resuming')).toBe(true)
    m = reduceControl(m, { type: 'settle', tabId: 't1' })
    expect(m.get('t1')).toMatchObject({ state: 'driving', solvedAt: null })
  })

  it('a challenge only starts while the agent drives', () => {
    let m = claim(empty, 't1')
    m = reduceControl(m, { type: 'take-over', tabId: 't1' })
    expect(reduceControl(m, { type: 'challenge', tabId: 't1' })).toBe(m)
  })

  it('nudges count only while the shield is up', () => {
    let m = claim(empty, 't1')
    m = reduceControl(m, { type: 'nudge', tabId: 't1' })
    expect(m.get('t1')?.nudge).toBe(1)
    m = reduceControl(m, { type: 'take-over', tabId: 't1' })
    expect(reduceControl(m, { type: 'nudge', tabId: 't1' })).toBe(m)
  })

  it('unknown tabs are ignored', () => {
    for (const type of ['take-over', 'hand-back', 'challenge', 'settle', 'nudge', 'release'] as const) expect(reduceControl(empty, { type, tabId: 'x' } as never)).toBe(empty)
  })
})

describe('notice position', () => {
  it('clamps and rounds', () => {
    expect(clampPosition({ x: -5, y: 1e9 })).toEqual({ x: 0, y: 20_000 })
    expect(clampPosition({ x: Number.NaN, y: 3.6 })).toEqual({ x: 0, y: 4 })
  })

  it('anchors at the tab or at the dragged point', () => {
    expect(noticeAnchorRect(null)).toBeNull()
    expect(noticeAnchorRect({ x: 200, y: 30 })).toEqual({ x: 200, y: 30, width: 0, height: 0 })
  })

  it('moves within the tab and reports the top centre', () => {
    const frame = { x: 100, y: 12, width: 300, height: 44 }
    expect(movedPosition(frame, { x: 50, y: 100 }, { width: 1000, height: 800 })).toEqual({ x: 300, y: 100 })
    // Dragged past the right and bottom edges, it stops inside.
    expect(movedPosition(frame, { x: 5000, y: 5000 }, { width: 1000, height: 800 })).toEqual({ x: 850, y: 744 })
  })
})

describe('plain words and props', () => {
  it('maps tool kinds to words and props', () => {
    expect(activityKey('read-page')).toBe('atWork.activity.reading')
    expect(activityKey('web-search')).toBe('atWork.activity.searching')
    expect(activityKey(undefined)).toBe('atWork.activity.working')
    expect(activityProp('find')).toBe('reading')
    expect(activityProp('web-search')).toBe('searching')
    expect(activityProp('type')).toBe('typing')
    expect(activityProp('click')).toBeNull()
  })

  it('reads kinds from members and from older labels', () => {
    expect(toolKindOf('left_click')).toBe('click')
    expect(toolKindOf('form_input')).toBe('type')
    expect(toolKindOf('new_tab')).toBe('tabs')
    expect(kindFromLabel('Read the page')).toBe('read-page')
    expect(kindFromLabel('Search the web for "x"')).toBe('web-search')
    expect(kindFromLabel('Read https://example.com')).toBe('web-fetch')
    expect(kindFromLabel('Open a new tab')).toBe('tabs')
    expect(kindFromLabel('Open https://example.com')).toBe('navigate')
    expect(kindFromLabel('Type "hello"')).toBe('type')
    expect(kindFromLabel('Click ref_3')).toBe('click')
  })
})

describe('human verification pages', () => {
  it('spots interstitials and visible widgets', () => {
    expect(isChallengePage({ url: 'https://shop.example/cdn-cgi/challenge-platform/h/b', title: '', frames: [] })).toBe(true)
    expect(isChallengePage({ url: 'https://example.com/', title: 'Just a moment...', frames: [] })).toBe(true)
    expect(isChallengePage({ url: 'https://example.com/', title: 'Shoes', frames: ['https://www.google.com/recaptcha/api2/anchor?k=1&size=normal'] })).toBe(true)
    expect(isChallengeFrame('https://newassets.hcaptcha.com/captcha/v1/abc')).toBe(true)
    expect(isChallengeFrame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x')).toBe(true)
  })

  it('ignores ordinary pages, invisible widgets and look-alikes', () => {
    expect(isChallengePage({ url: 'https://example.com/', title: 'Shoes', frames: ['https://www.youtube.com/embed/x'] })).toBe(false)
    expect(isChallengeFrame('https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible')).toBe(false)
    expect(isChallengeFrame('https://www.google.com/maps/embed')).toBe(false)
    expect(isChallengeFrame('https://hcaptcha.com.evil.example/')).toBe(false)
    expect(isChallengeFrame('javascript:alert(1)')).toBe(false)
  })
})

describe('the status pill', () => {
  const chat = (id: string, status: 'idle' | 'running' | 'needs-approval') => ({ id, companionId: 'pip', status, title: id })

  it('shows nothing while the panel is open or nothing works', () => {
    expect(pillState([chat('a', 'running')], true)).toBeNull()
    expect(pillState([chat('a', 'idle')], false)).toBeNull()
  })

  it('a chat that needs you comes first', () => {
    expect(pillState([chat('a', 'running'), chat('b', 'needs-approval'), chat('c', 'running')], false)).toEqual({ chatId: 'b', companionId: 'pip', mode: 'approval', others: 2 })
  })

  it('words', () => {
    const companion = { id: 'pip', name: 'Pip', accent: '#6a4bff', glow: '#6a4bff' }
    expect(pillText({ mode: 'working', companion, label: 'Reading the page', others: 0 })).toEqual({ title: 'Pip is working', detail: 'Reading the page' })
    expect(pillText({ mode: 'approval', companion, label: '', others: 2 }).detail).toBe('and 2 more')
  })
})

describe('notice content', () => {
  const base = { activity: 'Reading the page', companion: { id: 'pip', name: 'Pip', accent: '#6a4bff', glow: '#6a4bff' }, solvedAt: null, nudge: 0 }

  it('offers take over while driving and hand back once yours', () => {
    expect(noticeContent({ ...base, state: 'driving' }, 0)).toMatchObject({ title: 'Pip is using this tab', detail: 'Reading the page', primary: 'take-over' })
    expect(noticeContent({ ...base, state: 'taken-over' }, 0)).toMatchObject({ tone: 'yours', primary: 'hand-back' })
    expect(noticeContent({ ...base, state: 'paused' }, 0).primary).toBe('resume')
  })

  it('asks for the check, then confirms briefly', () => {
    const challenge = noticeContent({ ...base, state: 'challenge' }, 0)
    expect(challenge).toMatchObject({ tone: 'challenge', primary: 'solved' })
    expect(challenge.actions).toEqual(['skip', 'open-chat', 'stop'])
    expect(noticeContent({ ...base, state: 'resuming', solvedAt: 1000 }, 2000).tone).toBe('solved')
    expect(noticeContent({ ...base, state: 'resuming', solvedAt: 1000 }, 9000).tone).toBe('working')
  })

  it('calls out a click on the shield until it was seen', () => {
    expect(noticeContent({ ...base, state: 'driving', nudge: 1 }, 0, 0)).toMatchObject({ nudged: true, detail: 'Want to use this tab yourself?' })
    expect(noticeContent({ ...base, state: 'driving', nudge: 1 }, 0, 1).nudged).toBe(false)
  })

  it('maps actions onto the agent services', () => {
    const p = { tabId: 't1', chatId: 'c1' }
    expect(actionCall('take-over', p)).toEqual({ method: 'takeOver', args: ['t1'] })
    expect(actionCall('resume', p)).toEqual({ method: 'resume', args: ['c1'] })
    expect(actionCall('solved', p)).toEqual({ method: 'challengeDone', args: ['t1'] })
    expect(actionCall('beside', p)).toEqual({ method: 'reveal', args: ['t1', 'beside'] })
  })
})

describe('AgentControl in main', () => {
  function setup() {
    let listener: ((s: ControlSignal) => void) | null = null
    const agent: AgentControlHost & { calls: string[] } = {
      calls: [],
      onControl: (fn) => {
        listener = fn
        return () => (listener = null)
      },
      companionOf: () => 'pip',
      stop: (id) => {
        agent.calls.push(`stop:${id}`)
        return []
      },
      pause: (id) => {
        agent.calls.push(`pause:${id}`)
        // The chat's seam may still throw; control must carry on.
        throw new Error('Not available yet')
      },
      resume: (id) => void agent.calls.push(`resume:${id}`),
      noteForNextResult: (tabId) => void agent.calls.push(`note:${tabId}`),
    }
    const events: AppEvent[] = []
    const sent: AppEvent[] = []
    const win = { send: (e: AppEvent) => sent.push(e), tabs: { activeId: () => 't1', activate: vi.fn() } }
    const control = new AgentControl({
      agent,
      tab: () => undefined,
      tabByWebContents: () => undefined,
      windowOf: () => win as never,
      broadcast: (e) => events.push(e),
      now: () => 5000,
    })
    control.start()
    const signal = (s: ControlSignal): void => listener?.(s)
    return { control, agent, events, sent, signal }
  }

  it('follows claims, activity and releases, and says so in both event forms', () => {
    const { control, events, signal } = setup()
    signal({ kind: 'claim', chatId: 'c1', tabId: 't1' })
    signal({ kind: 'event', chatId: 'c1', event: { type: 'tool', id: 'x', label: 'Read the page', state: 'running' } })
    expect(control.view('t1')).toMatchObject({ state: 'driving', activity: 'Reading the page', companionId: 'pip' })
    signal({ kind: 'release', chatId: 'c1', tabId: 't1' })
    expect(control.states()).toEqual([])
    const small = events.filter((e) => e.type === 'agent-control')
    expect(small.at(-1)).toMatchObject({ tabId: 't1', state: 'idle' })
    expect(events.filter((e) => e.type === 'agent-control-view').at(-1)).toMatchObject({ view: null })
    control.dispose()
  })

  it('take over pauses (even while the seam throws), hand back resumes with a note', () => {
    const { control, agent, signal } = setup()
    signal({ kind: 'claim', chatId: 'c1', tabId: 't1' })
    control.takeOver('t1')
    expect(control.view('t1')?.state).toBe('taken-over')
    control.handBack('t1')
    expect(control.view('t1')?.state).toBe('resuming')
    expect(agent.calls).toEqual(['pause:c1', 'note:t1', 'resume:c1'])
    control.dispose()
  })

  it('stop and reveal reach the right chat and window', () => {
    const { control, agent, sent, signal } = setup()
    signal({ kind: 'claim', chatId: 'c1', tabId: 't1' })
    control.stopTab('t1')
    control.reveal('t1', 'beside')
    expect(agent.calls).toContain('stop:c1')
    expect(sent).toEqual([{ type: 'chat-open', chatId: 'c1', where: 'beside', toggle: true }])
    control.dispose()
  })

  it('services cover the whole agent namespace', () => {
    const { control } = setup()
    expect(Object.keys(control.services()).sort()).toEqual(['challengeDone', 'controlStates', 'handBack', 'moveNotice', 'nudge', 'pause', 'resume', 'reveal', 'skipPage', 'stopTab', 'takeOver'])
    control.dispose()
  })
})
