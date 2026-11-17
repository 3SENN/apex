/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Face canvas layout from docs/companion-system.md, shared by the SVG
// writer and the head builder (which maps the canvas onto each head).

import { FACE_CANVAS } from './catalogue.mjs'

export const FACE = {
  width: FACE_CANVAS.width,
  height: FACE_CANVAS.height,
  eyeLeftX: 176,
  eyeRightX: 336,
  eyeY: 112,
  browY: 60,
  mouthX: 256,
  mouthY: 190,
  ink: '#1d1630',
  white: '#ffffff',
  mouth: '#4a1f3a',
}
