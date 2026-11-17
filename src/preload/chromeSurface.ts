/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome surface preload (src/main/chromeSurface.ts registers it on every
// browsing session, for every frame): before any page script runs, it fills
// the page's window.chrome the way stock Chrome has it (chromeSurfaceWorld.ts).
// It is the one piece of Atelier that runs in the page's own world on account
// sign-in pages too: stock Chromium has it there, and Gmail and YouTube send
// people on to sign-in. It also stands in for the window's frame while
// Chromium has none for the page yet (page/windowGeometry.ts), here rather
// than in the page preload because popups get only this one. That is the
// only thing it asks main, and it exposes nothing else.
import { contextBridge } from 'electron'
import { installChromeSurface } from './chromeSurfaceWorld'
import { installWindowGeometry } from './page/windowGeometry'

/** Web documents, and the about:, data: and blob: ones they open. Extension and Atelier pages keep their own. */
const WEB = ['http:', 'https:', 'about:', 'data:', 'blob:', 'file:']

let protocol = ''
try {
  protocol = globalThis.location?.protocol ?? ''
} catch {
  protocol = ''
}
if (WEB.includes(protocol)) {
  try {
    contextBridge.executeInMainWorld({ func: installChromeSurface })
  } catch {
    // A world that can't be reached keeps Chromium's own window.chrome.
  }
  // Every frame, tabs and popups, sign-in pages too: a page Chromium already placed gets nothing.
  try {
    installWindowGeometry()
  } catch {
    // The page keeps Chromium's value.
  }
}
