/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'

// The chrome surface (src/preload/chromeSurfaceWorld.ts): window.chrome as
// stock desktop Chrome fills it, in every frame of every page a browsing
// session shows, popups and sign-in pages included. A session preload runs
// before the webContents' own preload and in every frame where that one runs
// (tabs set nodeIntegrationInSubFrames); about:blank subframes, where Electron
// runs none, are filled from the frame that reaches them.

export const CHROME_SURFACE_PRELOAD_ID = 'atelier-chrome-surface'

type PreloadSession = Pick<Session, 'getPreloadScripts' | 'registerPreloadScript'>

/** Registers the frame preload on a browsing session, once. False when the session can't take one. */
export function installChromeSurface(session: PreloadSession, filePath: string): boolean {
  if (typeof session.registerPreloadScript !== 'function' || typeof session.getPreloadScripts !== 'function') return false
  if (session.getPreloadScripts().some((p) => p.id === CHROME_SURFACE_PRELOAD_ID)) return true
  session.registerPreloadScript({ id: CHROME_SURFACE_PRELOAD_ID, type: 'frame', filePath })
  return true
}
