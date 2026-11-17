/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BrowserWindow, TitleBarOverlayOptions } from 'electron'
import type { LayoutMode } from '@shared/ipc'
import { profileTokens, type ProfileHue } from '@shared/profile'
import { TITLE_BAR_HEIGHT } from '@shared/system'
import type { ThemeMode } from '@shared/theme'

// Windows and Linux draw the window controls over the
// chrome (titleBarStyle 'hidden' plus titleBarOverlay), so the toolbar runs
// to the window's top edge as it does beside the macOS traffic lights. The
// overlay is painted in whatever sits under it, from the same values as the
// chrome's tokens, and recoloured when the theme, hue or layout changes.

/** Mirrors of styles.css tokens main can't read: --bg-card (the sheet) and --text-primary. */
const SHEET = { light: '#fdfcfa', dark: '#222120' } as const
const INK = { light: '#1c1a17', dark: '#f1efec' } as const

/** The sidebar layout puts the toolbar's sheet under the controls; the horizontal one the tab strip's ground. */
export function titleBarOverlayFor(o: { mode: ThemeMode; layout: LayoutMode; hue: ProfileHue }): { color: string; symbolColor: string; height: number } {
  const color = o.layout === 'sidebar' ? SHEET[o.mode] : profileTokens(o.hue, o.mode).ground
  return { color, symbolColor: INK[o.mode], height: TITLE_BAR_HEIGHT }
}

/** The window options the window factory spreads in: nothing on macOS (hiddenInset stays). */
export function titleBarWindowOptions(platform: NodeJS.Platform, look: { mode: ThemeMode; layout: LayoutMode; hue: ProfileHue }): { titleBarStyle?: 'hidden'; titleBarOverlay?: TitleBarOverlayOptions } {
  if (platform !== 'win32' && platform !== 'linux') return {}
  return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlayFor(look) }
}

export function recolourTitleBar(win: BrowserWindow, look: { mode: ThemeMode; layout: LayoutMode; hue: ProfileHue }): void {
  if ((process.platform !== 'win32' && process.platform !== 'linux') || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(titleBarOverlayFor(look))
  } catch {
    // A window made without an overlay (a popup) has nothing to recolour.
  }
}
