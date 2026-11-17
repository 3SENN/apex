/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The branding's wordmark (branding/<id>/renderer/logo.svg) read into what
// BrandLogo draws: the viewBox and each path with its class. Only the
// official branding has one; the unofficial logo is the name in the UI font
// beside the mark. Pure, so tests read the committed file with it.

export interface Wordmark {
  width: number
  height: number
  paths: ReadonlyArray<{ className: string; d: string }>
}

/** Parses the wordmark SVG: its viewBox and the paths that carry a class. Null when it has neither. */
export function parseWordmark(svg: string): Wordmark | null {
  const box = /<svg\b[^>]*\bviewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg)
  if (!box) return null
  const paths: Array<{ className: string; d: string }> = []
  for (const [tag] of svg.matchAll(/<path\b[^>]*>/g)) {
    const className = /\bclass="([^"]+)"/.exec(tag)?.[1]
    const d = /\bd="([^"]+)"/.exec(tag)?.[1]
    if (className && d) paths.push({ className, d })
  }
  const width = Number(box[1])
  const height = Number(box[2])
  return paths.length > 0 && width > 0 && height > 0 ? { width, height, paths } : null
}
