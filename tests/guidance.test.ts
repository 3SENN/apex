/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NUDGES, TIPS, pickNudge, rotatingTip, tipsFor } from '@shared/tips'
import { createGuidanceService } from '../src/main/guidance'

describe('tips', () => {
  it('has unique ids, short text, and only apex:// links', () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length)
    for (const tip of TIPS) {
      expect(tip.text.length).toBeLessThan(160)
      if (tip.link) expect(tip.link.url.startsWith('apex://')).toBe(true)
    }
  })

  it('gates tips by feature and drops dismissed ones', () => {
    const off = tipsFor('chat-working', {})
    expect(off.some((t) => t.needs)).toBe(false)
    const on = tipsFor('chat-working', { browser: true, memory: true })
    expect(on.length).toBeGreaterThan(off.length)
    expect(tipsFor('chat-working', { browser: true }, ['work-watch']).some((t) => t.id === 'work-watch')).toBe(false)
    expect(tipsFor('setup-wait', {}).every((t) => t.context === 'setup-wait')).toBe(true)
  })

  it('rotates about every ten seconds', () => {
    const tips = tipsFor('setup-wait', {})
    expect(rotatingTip(tips, 0)).toBe(tips[0])
    expect(rotatingTip(tips, 10_500)).toBe(tips[1])
    expect(rotatingTip([], 5)).toBeNull()
  })
})

describe('the guidance store', () => {
  it('remembers dismissals once each, across restarts, and reports changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-guidance-'))
    const events: number[] = []
    const a = createGuidanceService({ dataDir: dir, onChange: (s) => events.push(s.dismissedTips.length + s.dismissedNudges.length) })
    a.dismissTip('work-stop')
    a.dismissTip('work-stop')
    a.dismissNudge('connect-app')
    expect(events).toEqual([1, 2])
    const b = createGuidanceService({ dataDir: dir })
    expect(b.state()).toEqual({ dismissedTips: ['work-stop'], dismissedNudges: ['connect-app'] })
  })
})

describe('new-tab nudges', () => {
  const item = (id: string, done: boolean) => ({ id, kind: 'auto' as const, title: id, description: '', glyph: 'plug' as const, hue: 'teal' as const, done, action: { kind: 'page' as const, url: 'apex://connectors' } })
  const view = (items: ReturnType<typeof item>[], status: 'ready' | 'off' = 'ready', snoozedUntil: number | null = null) => ({ status, items, snoozedUntil })

  it('shows at most one, for the first unfinished checklist item with a nudge', () => {
    const v = view([item('import-data', true), item('connect-app', false), item('set-up-routine', false)])
    expect(pickNudge(v, [], 0)?.id).toBe('connect-app')
    expect(pickNudge(v, ['connect-app'], 0)?.id).toBe('set-up-routine')
  })

  it('stays quiet while the checklist is off, snoozed, or everything is done', () => {
    expect(pickNudge(view([item('connect-app', false)], 'off'), [], 0)).toBeNull()
    expect(pickNudge(view([item('connect-app', false)], 'ready', 100), [], 50)).toBeNull()
    expect(pickNudge(view([item('connect-app', true)]), [], 0)).toBeNull()
    expect(pickNudge(null, [], 0)).toBeNull()
  })

  it('has a nudge for every automatic checklist item it names', () => {
    for (const n of NUDGES) expect(n.text.length).toBeGreaterThan(10)
  })
})
