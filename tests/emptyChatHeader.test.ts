/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { isStartSurface, showsChatHeader } from '../src/renderer/src/components/startSurfaceLogic'

// DS-107: the empty chat page is the start surface, with no header bar; the
// switcher in the start chrome stays reachable, and the side panel keeps its
// header.

const draft = isStartSurface({ empty: true, phase: 'ready', draft: true, imported: undefined })

describe('empty chat header', () => {
  it('drops the bar on the empty chat page', () => {
    expect(draft).toBe(true)
    expect(showsChatHeader({ variant: 'page', phase: 'ready', startSurface: draft, hasCompanion: true })).toBe(false)
  })

  it('keeps it once the chat has started, or when it is not a draft', () => {
    expect(showsChatHeader({ variant: 'page', phase: 'ready', startSurface: false, hasCompanion: true })).toBe(true)
    const subAgent = isStartSurface({ empty: true, phase: 'ready', draft: false, imported: undefined })
    expect(showsChatHeader({ variant: 'page', phase: 'ready', startSurface: subAgent, hasCompanion: true })).toBe(true)
  })

  it('keeps it when no switcher could stand in for it', () => {
    expect(showsChatHeader({ variant: 'page', phase: 'ready', startSurface: true, hasCompanion: false })).toBe(true)
  })

  it('the panel keeps its header; a loading or failed page draws none', () => {
    expect(showsChatHeader({ variant: 'panel', phase: 'ready', startSurface: true, hasCompanion: true })).toBe(true)
    expect(showsChatHeader({ variant: 'panel', phase: 'loading', startSurface: false, hasCompanion: true })).toBe(true)
    expect(showsChatHeader({ variant: 'page', phase: 'loading', startSurface: false, hasCompanion: true })).toBe(false)
    expect(showsChatHeader({ variant: 'page', phase: 'failed', startSurface: false, hasCompanion: true })).toBe(false)
  })
})
