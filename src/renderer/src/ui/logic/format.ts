/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Small formatting helpers for the kit's components.

/** Joins class names, skipping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Badge counts: "7", "99+". */
export function formatCount(n: number, max = 99): string {
  return n > max ? `${max}+` : String(Math.max(0, Math.floor(n)))
}

/** The new name from an inline rename, or null to leave the old one. */
export function resolveRename(original: string, draft: string, maxLength?: number): string | null {
  let next = draft.replace(/\s+/g, ' ').trim()
  if (maxLength !== undefined) next = next.slice(0, maxLength).trim()
  return next && next !== original ? next : null
}

export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

/** Where a native menu opens for an anchor: under its left edge. */
export function menuAnchorPoint(rect: RectLike, gap = 4): { x: number; y: number } {
  return { x: Math.round(rect.left), y: Math.round(rect.bottom + gap) }
}

/** Geometry for an SVG progress ring; value is 0 to 1. */
export function ringGeometry(size: number, stroke: number, value: number): { radius: number; circumference: number; offset: number } {
  const radius = Math.max(0, (size - stroke) / 2)
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  return { radius, circumference, offset: circumference * (1 - clamped) }
}
