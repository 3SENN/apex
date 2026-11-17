/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Assembles every 3D part into a glTF builder: one root node named by the
// part id, its meshes as children, and (for heads) the face surface and the
// anchor nodes.

import { EAR_ACCESSORIES, EARS, EYE_ACCESSORIES } from './accessories.mjs'
import { PART_IDS, TINTS } from './catalogue.mjs'
import { GltfBuilder } from './gltf.mjs'
import { HAIR } from './hair.mjs'
import { HATS } from './hats.mjs'
import { buildHead } from './heads.mjs'
import { PROPS } from './props.mjs'

const HEAD_ANCHORS = ['hat', 'hair', 'ears', 'eyeAccessory', 'earAccessory']

const SOURCES = {
  ears: EARS,
  hair: HAIR,
  hat: HATS,
  eyeAccessory: EYE_ACCESSORIES,
  earAccessory: EAR_ACCESSORIES,
  prop: PROPS,
}

function finish(id, slot, label, builder, extra = {}) {
  const tints = TINTS.filter((t) => builder.tints.has(t))
  return { id, slot, label, file: `parts/${id}.glb`, tints, builder, ...extra }
}

export function buildParts() {
  const parts = []
  for (const id of PART_IDS.head) {
    const head = buildHead(id)
    const b = new GltfBuilder(id)
    const root = b.node(id)
    b.mesh(`${id}-mesh`, { 'tint:skin': head.head }, root)
    b.mesh('face', { face: head.face }, root, { uv: true })
    for (const a of HEAD_ANCHORS) b.node(`anchor:${a}`, { t: head.anchors[a].t, s: head.anchors[a].s }, root)
    parts.push(finish(id, 'head', head.label, b, { head }))
  }
  for (const [slot, source] of Object.entries(SOURCES)) {
    const known = new Set(Object.keys(source))
    for (const id of PART_IDS[slot]) {
      const def = source[id]
      if (!def) throw new Error(`no generator for ${slot} part ${id}`)
      known.delete(id)
      const b = new GltfBuilder(id)
      const root = b.node(id)
      b.mesh(`${id}-mesh`, def.build(), root)
      parts.push(finish(id, slot, def.label, b, { def }))
    }
    if (known.size) throw new Error(`parts not in the contract: ${[...known].join(', ')}`)
  }
  return parts
}
