/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { iconTooltip } from '../src/renderer/src/ui/logic/iconTooltip'

// DS-95: icon buttons draw the dark overlay tooltip, with the shortcut as key
// caps when it is a shortcut table row, instead of setting a native title.

describe('iconTooltip', () => {
  it('shows the label alone without a shortcut', () => {
    expect(iconTooltip('Reload', undefined, undefined, true)).toEqual({ label: 'Reload', shortcutId: null })
  })

  it('names a shortcut table row, whatever the key order or case', () => {
    expect(iconTooltip('New tab', 'CmdOrCtrl+T', undefined, true)).toEqual({ label: 'New tab', shortcutId: 'new-tab' })
    expect(iconTooltip('New tab', 't+cmdorctrl', undefined, true)).toEqual({ label: 'New tab', shortcutId: 'new-tab' })
  })

  it('writes a shortcut with no table row after the label', () => {
    const tip = iconTooltip('Odd one', 'CmdOrCtrl+Alt+Shift+F12', undefined, true)
    expect(tip?.shortcutId).toBeNull()
    expect(tip?.label.startsWith('Odd one (')).toBe(true)
  })

  it('takes custom text as is, and none for false or empty', () => {
    expect(iconTooltip('Close', 'CmdOrCtrl+W', 'Close this panel', true)).toEqual({ label: 'Close this panel', shortcutId: null })
    expect(iconTooltip('Close', undefined, false, true)).toBeNull()
    expect(iconTooltip('Close', undefined, '', true)).toBeNull()
  })
})
