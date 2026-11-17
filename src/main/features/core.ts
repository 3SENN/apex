/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoreServices } from '@shared/services/core'
import type { WindowManager } from '../windows'
import type { Feature, ServiceParts } from './types'

// Windows, sessions, shortcuts and the overlay host. The app-wide
// parts act on the WindowManager; the window parts act on the calling window
// (its id and kind, focus mode, and closing it). The rest of this wiring
// (routers, session restore, shortcuts, the Dock) is in ../app.ts.
export const coreFeature: Feature = {
  name: 'core',
  app(app): ServiceParts {
    manager = app.windows
    const windows: Partial<CoreServices['windows']> = {
      list: () => app.windows.list(),
      open: (kind, options) => app.windows.open(kind, options),
      focus: (id) => app.windows.focus(id),
      close: (id) => {
        const win = id === undefined ? app.windows.focused() : app.windows.get(id)
        win?.window.close()
      },
      openChat: (chatId) => app.windows.openChat(chatId),
      recentlyClosed: () => app.windows.recentlyClosed(),
      reopen: (index) => app.windows.reopen(index),
    }
    return { windows }
  },
  window(win): ServiceParts {
    const windows: Partial<CoreServices['windows']> = {
      current: () => ({ id: win.id, kind: win.kind, focusMode: win.chromeWindow.state().focusMode === true }),
      setFocusMode: (on) => {
        win.chromeWindow.setFocusMode(on)
        win.send({ type: 'focus-mode', on })
      },
      // Without an id, the caller's own window (its close button, ⇧⌘W in its menu).
      close: (id) => {
        if (id === undefined) win.window.close()
        else manager?.get(id)?.window.close()
      },
    }
    return { windows }
  },
}

// The window parts close other windows by id through the manager the app part saw.
let manager: WindowManager | null = null
