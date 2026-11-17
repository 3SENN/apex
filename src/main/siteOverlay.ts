/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OverlayResult, Rect, SurfaceAnchor, SurfaceId, SurfaceProps } from '@shared/overlay'
import type { WindowContext } from './features/types'
import { log } from './log'
import type { Tab } from './tabs'
import type { WindowManager } from './windows'

// How the site features' main-side surfaces reach the screen: the prompt sits
// under the pill's site-info button, the pickers over the tab's pane. Every
// surface is tied to its tab, so the overlay host hides it while another tab
// shows and closes it with the tab.

export function windowOfTab(windows: WindowManager, tab: Tab): WindowContext | null {
  return windows.all().find((w) => w.tabs.find(tab.id) === tab) ?? null
}

/** The tab's pane in chrome CSS px, or null when it isn't showing. */
export function paneRect(win: WindowContext, tab: Tab): Rect | null {
  const pane = win.tabs.paneBounds(tab.id)
  if (!pane || pane.width <= 0) return null
  const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
  return { x: pane.x / zoom, y: pane.y / zoom, width: pane.width / zoom, height: pane.height / zoom }
}

/** The pill's site-info button, read from the chrome (only while this tab is the one it shows). */
async function siteButtonRect(win: WindowContext): Promise<Rect | null> {
  if (win.chrome.isDestroyed()) return null
  try {
    const r = (await win.chrome.executeJavaScript(
      `(() => { const b = document.querySelector('.pill__info'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null })()`,
    )) as Rect | null
    return r && Number.isFinite(r.x) && Number.isFinite(r.y) ? r : null
  } catch {
    return null
  }
}

/** Under the site-info button when the tab is in front; otherwise the top-left of its pane. */
export async function siteButtonAnchor(win: WindowContext, tab: Tab): Promise<SurfaceAnchor> {
  const showing = win.tabs.activeId() === tab.id
  const button = showing ? await siteButtonRect(win) : null
  if (button) return { kind: 'window', rect: button }
  const pane = paneRect(win, tab)
  if (pane) return { kind: 'window', rect: { x: pane.x + 12, y: pane.y, width: 0, height: 0 } }
  return { kind: 'tab', tabId: tab.id, rect: null }
}

/** The whole pane, for modal pickers and the sharing bar. */
export function paneAnchor(win: WindowContext, tab: Tab): SurfaceAnchor {
  const pane = paneRect(win, tab)
  return pane ? { kind: 'window', rect: pane } : { kind: 'tab', tabId: tab.id, rect: null }
}

let warned = false

/** Opens a surface tied to a tab; resolves null when the overlay host can't show it or it fails. */
export async function presentSurface<S extends SurfaceId>(win: WindowContext, surface: S, anchor: SurfaceAnchor, props: SurfaceProps<S>, tabId: string): Promise<OverlayResult | null> {
  try {
    return await win.overlay.open(surface, anchor, props, { tabId })
  } catch (err) {
    if (!warned) {
      warned = true
      log.warn('sites', `The ${surface} surface could not open; requests are refused until it can`, { error: err instanceof Error ? err.message : String(err) })
    }
    return null
  }
}

/** The value a surface resolved with, or null when it was dismissed. */
export function resultValue(result: OverlayResult | null): unknown {
  return result && 'value' in result ? result.value : null
}
