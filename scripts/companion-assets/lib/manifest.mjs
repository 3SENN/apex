/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// manifest.json: every rig, part, face layer and config file, with labels.

import { FACE_LAYERS, PART_SLOTS, RIGS } from './catalogue.mjs'
import { RIG_LABELS } from './rigs.mjs'

export function buildManifest({ parts, face, configs }) {
  const rigs = Object.fromEntries(RIGS.map((id) => [id, { label: RIG_LABELS[id], file: `rigs/${id}.glb` }]))
  const partDefs = {}
  for (const slot of PART_SLOTS) {
    for (const p of parts.filter((x) => x.slot === slot)) partDefs[p.id] = { slot, label: p.label, file: p.file, tints: p.tints }
  }
  const faceDefs = Object.fromEntries(FACE_LAYERS.map((layer) => [layer, face.defs[layer]]))
  return { version: 1, rigs, parts: partDefs, face: faceDefs, config: { ...configs.paths } }
}
