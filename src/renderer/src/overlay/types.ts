/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ComponentType } from 'react'
import type { ZodType } from 'zod'
import type { Rect, SurfaceAnchor, SurfaceId, SurfacePolicy } from '@shared/overlay'
import type { Placement } from '@shared/overlayLayout'

// A renderer surface module: a component, a zod schema for its props
// and its policy. Each domain exports a map of these keyed by SurfaceId from
// overlay/surfaces/<domain>/index.ts; overlay/registry.ts merges them.

/** What a mounted surface receives from the overlay host. */
export interface SurfaceComponentProps<P> {
  instanceId: string
  props: P
  anchor: SurfaceAnchor
  windowId: number
  /** Resolves the opener's promise with a value and starts the exit. */
  resolve(value: unknown): void
  /** Dismisses without a value. */
  close(): void
  /** Reports the drawn size so the host can size its view to the open surfaces. */
  reportBounds(rect: Rect): void
  /** True while the exit animation plays (policy.exitMs; instant under reduced motion). */
  exiting: boolean
  // Optional: chrome-hosted fallbacks don't have them
  /** The anchor resolved to a window CSS rect (tab anchors against their pane); null while the tab has no pane. */
  anchorRect?: Rect | null
  /** The window's content area in CSS px. */
  viewport?: Rect
  /** The tab the surface belongs to, if any. */
  tabId?: string | null
  // ── permissions pass: frame extras ── (opt-in: only surfaces that read it change)
  /** True while the frame is placed and on screen; false while hidden (another tab shows) or not yet measured. */
  shown?: boolean
}

export interface SurfaceModule<P = unknown> {
  component: ComponentType<SurfaceComponentProps<P>>
  props: ZodType<P>
  policy: SurfacePolicy
  // Fixed-size surfaces; fill ones lay themselves out
  /** Where the frame goes beside its anchor; 'below' when omitted. Shifted to stay inside the window. */
  placement?: Placement | ((props: P) => Placement)
  /** The gap to the anchor in CSS px (6 when omitted). */
  gap?: number
}

export type SurfaceMap = Partial<Record<SurfaceId, SurfaceModule<never>>>

/**
 * Policy shorthands; surfaces spread one and override what differs. Menus,
 * popovers and hints close within one frame (DS-82, superseding OV-02's
 * exit for them); modals, sheets and toasts keep a short exit.
 */
export const MENU_POLICY: SurfacePolicy = {
  tier: 'interactive',
  size: 'fixed',
  outsideClick: 'close',
  blocksPage: false,
  onTabSwitch: 'close',
  layer: 'menu',
  focus: true,
  exitMs: 0,
}

export const MODAL_POLICY: SurfacePolicy = {
  tier: 'interactive',
  size: 'fill-window',
  outsideClick: 'ignore',
  blocksPage: true,
  onTabSwitch: 'stay',
  layer: 'modal',
  focus: true,
  exitMs: 160,
}

export const HINT_POLICY: SurfacePolicy = {
  tier: 'passive',
  size: 'fixed',
  outsideClick: 'ignore',
  blocksPage: false,
  onTabSwitch: 'close',
  layer: 'hint',
  focus: false,
  exitMs: 0,
}
