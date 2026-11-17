/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// branding/official/Apex.icon: the Icon Composer document macOS 26 compiles (through
// actool) into Assets.car. It holds the mark as one bitmap layer (white, the
// eyes cut out so the fill shows through) over a flat violet fill; the
// system draws the squircle mask, glass, lighting and shadows, and derives
// the dark, clear and tinted looks from the specialisations here.

import { iconComposerLayers, markOps, PALETTE } from './art.mjs'
import { encodePNG } from './lib/png.mjs'
import { hex, render } from './lib/raster.mjs'

function colour(key, alpha = 1) {
  const [r, g, b, a] = hex(PALETTE[key], alpha)
  return `srgb:${r.toFixed(5)},${g.toFixed(5)},${b.toFixed(5)},${a.toFixed(5)}`
}

/** The files inside Apex.icon, in a fixed order: [relative path, kind]. */
export const BUNDLE_FILES = [
  ['icon.json', 'json'],
  ['Assets/pip.png', 'png']
]

/** Returns Map<relative path inside Apex.icon, string | Buffer>. */
export function buildIconBundle() {
  const L = iconComposerLayers()
  const files = new Map()
  // The mark where the icon puts it, on a clear 1024 canvas; no shadow (the system adds one).
  const ops = markOps(L.mark, { head: hex(PALETTE.glyph), eyes: null })
  files.set('Assets/pip.png', encodePNG(L.size, L.size, render(ops, L.size, L.size).toRGBA8()))
  const json = {
    'fill-specializations': [
      { value: { solid: colour('violet') } },
      { appearance: 'dark', value: { solid: colour('darkTile') } }
    ],
    groups: [
      {
        name: 'Pip',
        layers: [{ 'image-name': 'pip.png', name: 'pip', glass: false }],
        shadow: { kind: 'neutral', opacity: 0.5 },
        translucency: { enabled: false, value: 0 },
        specular: false
      }
    ],
    'supported-platforms': {
      squares: ['macOS']
    }
  }
  files.set('icon.json', JSON.stringify(json, null, 2) + '\n')
  return files
}
