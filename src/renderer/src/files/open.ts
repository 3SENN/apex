/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileViewerUrl, type ViewerTarget } from '@shared/files'
import type { OverlayResult, SurfaceAnchor } from '@shared/overlay'
import type { FilesSurfaceId, FilesSurfaceProps } from '@shared/overlay/files'
import { call } from '../api'
import { openInChrome, pressAnchor } from '../overlay/kit/chromeHost'
import { anchorFromElement, openSurface } from '../overlay/useSurface'
import type { SurfaceModule } from '../overlay/types'
import { FILES_SURFACE_MAP } from '../overlay/surfaces/files'

// The renderer's way into the file viewer and its overlay surfaces. Each
// surface opens in the overlay host (over the page), or in the chrome
// itself while that host isn't available.

/** Opens a file in the viewer tab (atelier://file). `edit` starts in edit mode; `newTab` never reuses a tab. */
export function openViewer(target: ViewerTarget, options: { edit?: boolean; newTab?: boolean; name?: string } = {}): Promise<void> {
  return call('pages', 'open', fileViewerUrl(target, { edit: options.edit, name: options.name }), options.newTab ? { newTab: true } : undefined)
}

function toAnchor(anchor: HTMLElement | SurfaceAnchor | null | undefined): SurfaceAnchor {
  if (!anchor) return { kind: 'window', rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } }
  return anchor instanceof HTMLElement ? anchorFromElement(anchor) : anchor
}

/** Opens one of the files domain's surfaces and resolves with its result. */
export async function openFilesSurface<S extends FilesSurfaceId>(surface: S, props: FilesSurfaceProps[S], anchor?: HTMLElement | SurfaceAnchor | null): Promise<OverlayResult> {
  const where = toAnchor(anchor)
  const el = anchor instanceof HTMLElement ? anchor : null
  const unpress = pressAnchor(el)
  try {
    return await openSurface(surface, where, props as never)
  } catch {
    unpress()
    // The overlay host isn't up: draw the surface in the chrome (the registry bundles the renderers already).
    const module = FILES_SURFACE_MAP[surface] as unknown as SurfaceModule<FilesSurfaceProps[S]>
    return openInChrome(module, props, where, { anchorEl: el })
  } finally {
    unpress()
  }
}

/** Quick look: a sheet over the tab with the same renderers; Space or Esc closes it. */
export function openQuickLook(target: ViewerTarget, anchor?: HTMLElement | SurfaceAnchor | null): Promise<OverlayResult> {
  return openFilesSurface('quick-look', { target }, anchor)
}

/** The chat files modal (CH-28), optionally straight into one folder. */
export function openChatFiles(chatId: string, anchor?: HTMLElement | null, folder?: string): Promise<OverlayResult> {
  return openFilesSurface('chat-files-modal', folder ? { chatId, folder } : { chatId }, anchor)
}
