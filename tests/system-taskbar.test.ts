/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { pickOverlay, shouldFlash } from '../src/main/system/taskbar'

// The Windows taskbar overlay priority (ST-09) and the flash rule.

const images = {
  attention: { png: 'data:image/png;base64,QQ==', description: 'A chat needs you' },
  unread: { png: 'data:image/png;base64,Ug==', description: 'Unread' },
  companion: { png: 'data:image/png;base64,Qw==', description: 'Pip' },
}

describe('pickOverlay', () => {
  it('prefers attention, then unread, then the companion', () => {
    expect(pickOverlay({ needsYou: 1, unread: 3 }, images)?.kind).toBe('attention')
    expect(pickOverlay({ needsYou: 0, unread: 3 }, images)?.kind).toBe('unread')
    expect(pickOverlay({ needsYou: 0, unread: 0 }, images)?.kind).toBe('companion')
  })

  it('skips a kind the chrome has not drawn, and clears with nothing to show', () => {
    expect(pickOverlay({ needsYou: 1, unread: 0 }, { companion: images.companion })?.kind).toBe('companion')
    expect(pickOverlay({ needsYou: 1, unread: 1 }, { unread: images.unread })?.kind).toBe('unread')
    expect(pickOverlay({ needsYou: 0, unread: 0 }, { attention: images.attention, unread: images.unread })).toBeNull()
    expect(pickOverlay({ needsYou: 0, unread: 0 }, {})).toBeNull()
  })

  it('carries the image and its accessible text', () => {
    expect(pickOverlay({ needsYou: 2, unread: 0 }, images)).toEqual({ kind: 'attention', ...images.attention })
  })
})

describe('shouldFlash', () => {
  it('flashes only for a new approval while Atelier is in the background', () => {
    expect(shouldFlash({ needsYou: 0, unread: 0 }, { needsYou: 1, unread: 0 }, false)).toBe(true)
    expect(shouldFlash({ needsYou: 0, unread: 0 }, { needsYou: 1, unread: 0 }, true)).toBe(false)
    expect(shouldFlash({ needsYou: 2, unread: 0 }, { needsYou: 1, unread: 0 }, false)).toBe(false)
    expect(shouldFlash({ needsYou: 1, unread: 0 }, { needsYou: 1, unread: 5 }, false)).toBe(false)
  })
})
