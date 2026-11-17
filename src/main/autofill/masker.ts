/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { nativeImage, nativeTheme, type NativeImage, type Rectangle } from 'electron'
import type { Bounds } from '@shared/ipc'
import { parseInternalUrl } from '@shared/url'
import { MASK_FILL, maskBitmap, rectsToPixels } from './mask'
import type { Size } from './placement'

// Applies the guarded-field mask to a captured image (ST-15). Every
// capture that leaves main for a model (agent screenshots, voice commands)
// goes through here; the painting itself is the pure maskBitmap.

export interface GuardedArea {
  /** DIP, relative to the tab view. */
  rects: Bounds[]
  /** A frame with guarded fields couldn't be placed: cover everything. */
  unresolved: boolean
}

/**
 * Paints guarded rects over an image of `region` (DIP within a view of
 * `view`). Returns a new image; the input is not touched.
 */
export function applyMask(image: NativeImage, guarded: GuardedArea, view: Size, region?: Rectangle): NativeImage {
  const area: Bounds = region ?? { x: 0, y: 0, width: view.width, height: view.height }
  if (!guarded.unresolved && guarded.rects.length === 0) return image
  const size = image.getSize()
  if (size.width === 0 || size.height === 0) return image
  // Work at the image's real pixel density: toBitmap at its scale factor.
  const scale = Math.max(1, ...image.getScaleFactors())
  const pixels = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  let bitmap = Buffer.from(image.toBitmap({ scaleFactor: scale }))
  if (bitmap.length !== pixels.width * pixels.height * 4) {
    // Fall back to 1x when that representation isn't there.
    bitmap = Buffer.from(image.toBitmap())
    pixels.width = size.width
    pixels.height = size.height
    if (bitmap.length !== pixels.width * pixels.height * 4) return blankLike(size)
  }
  const color = nativeTheme.shouldUseDarkColors ? MASK_FILL.dark : MASK_FILL.light
  const rects = guarded.unresolved ? [{ x: 0, y: 0, width: pixels.width, height: pixels.height }] : rectsToPixels(guarded.rects, area, pixels)
  maskBitmap(bitmap, pixels, rects, color, guarded.unresolved ? 0 : Math.round(6 * scale))
  return nativeImage.createFromBitmap(bitmap, { width: pixels.width, height: pixels.height, scaleFactor: pixels.width / size.width })
}

/** A plain image of the mask colour: used when nothing about a capture can be trusted. */
export function blankLike(size: Size): NativeImage {
  const width = Math.max(1, Math.round(size.width))
  const height = Math.max(1, Math.round(size.height))
  const bitmap = Buffer.alloc(width * height * 4)
  const color = nativeTheme.shouldUseDarkColors ? MASK_FILL.dark : MASK_FILL.light
  maskBitmap(bitmap, { width, height }, [{ x: 0, y: 0, width, height }], color, 0)
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

/** Atelier pages that can show a revealed password: never captured. */
export function isSecretPage(internalUrl: string | null): boolean {
  if (!internalUrl) return false
  const route = parseInternalUrl(internalUrl)
  return route?.page === 'passwords' || (route?.page === 'settings' && route.section === 'passwords')
}

export function resizeToEdge(image: NativeImage, maxEdge: number | undefined): NativeImage {
  if (!maxEdge) return image
  const { width, height } = image.getSize()
  const edge = Math.max(width, height)
  if (edge <= maxEdge) return image
  const k = maxEdge / edge
  return image.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' })
}
