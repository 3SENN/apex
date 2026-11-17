/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Builds glTF documents with glTF-Transform and writes them compressed
// (dedup, weld, prune, then meshopt, which reorders, quantizes and applies
// EXT_meshopt_compression).

import { Document, Logger, NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { dedup, meshopt, prune, weld } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import { linearRgba, PAINTS, TINT_DEFAULTS } from './palette.mjs'

const r6 = (v) => {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? 0 : r
}

export class GltfBuilder {
  constructor(sceneName) {
    this.doc = new Document().setLogger(new Logger(Logger.Verbosity.WARN))
    this.doc.getRoot().getAsset().generator = 'Atelier companion generator'
    this.buffer = this.doc.createBuffer()
    this.scene = this.doc.createScene(sceneName)
    this.doc.getRoot().setDefaultScene(this.scene)
    this.materials = new Map()
    this.tints = new Set()
  }

  /** Materials: 'tint:<tint>', 'paint:<name>' or 'face'. */
  material(name) {
    let m = this.materials.get(name)
    if (m) return m
    let color
    if (name.startsWith('tint:')) {
      const tint = name.slice(5)
      color = TINT_DEFAULTS[tint]
      this.tints.add(tint)
    } else if (name.startsWith('paint:')) color = PAINTS[name.slice(6)]
    else if (name === 'face') color = '#ffffff'
    if (!color) throw new Error(`unknown material ${name}`)
    m = this.doc.createMaterial(name).setBaseColorFactor(linearRgba(color)).setMetallicFactor(0).setRoughnessFactor(1)
    this.materials.set(name, m)
    return m
  }

  node(name, { t, r, s } = {}, parent = null) {
    const n = this.doc.createNode(name)
    if (t) n.setTranslation(t.map(r6))
    if (r) n.setRotation(r.map(r6))
    if (s) n.setScale((typeof s === 'number' ? [s, s, s] : s).map(r6))
    if (parent) parent.addChild(n)
    else this.scene.addChild(n)
    return n
  }

  accessor(type, array) {
    return this.doc.createAccessor().setType(type).setArray(array).setBuffer(this.buffer)
  }

  /**
   * Adds a mesh node. `parts` maps material names to shapes; each becomes a
   * primitive. UVs are written only when `uv` is set (the face surface).
   */
  mesh(name, parts, parent, { uv = false, nodeName = name, t, r, s } = {}) {
    const mesh = this.doc.createMesh(name)
    for (const [materialName, shape] of Object.entries(parts)) {
      if (!shape || shape.idx.length === 0) continue
      const prim = this.doc.createPrimitive()
        .setAttribute('POSITION', this.accessor('VEC3', new Float32Array(shape.pos.map(r6))))
        .setAttribute('NORMAL', this.accessor('VEC3', new Float32Array(shape.nrm.map(r6))))
        .setMaterial(this.material(materialName))
      if (uv) prim.setAttribute('TEXCOORD_0', this.accessor('VEC2', new Float32Array(shape.uv.map(r6))))
      const count = shape.pos.length / 3
      prim.setIndices(this.accessor('SCALAR', count > 65535 ? new Uint32Array(shape.idx) : new Uint16Array(shape.idx)))
      mesh.addPrimitive(prim)
    }
    const node = this.node(nodeName, { t, r, s }, parent)
    node.setMesh(mesh)
    return node
  }

  /**
   * Adds a glTF animation. `tracks` is a list of { node, path, times, values }
   * where values are flat arrays (VEC3 for translation/scale, VEC4 quaternions).
   */
  animation(name, tracks) {
    const anim = this.doc.createAnimation(name)
    const inputs = new Map()
    for (const { node, path, times, values } of tracks) {
      const tk = times.join(',')
      let input = inputs.get(tk)
      if (!input) {
        input = this.accessor('SCALAR', new Float32Array(times))
        inputs.set(tk, input)
      }
      const output = this.accessor(path === 'rotation' ? 'VEC4' : 'VEC3', new Float32Array(values.map(r6)))
      const sampler = this.doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR')
      const channel = this.doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler)
      anim.addSampler(sampler).addChannel(channel)
    }
    return anim
  }
}

let ioPromise = null

async function io() {
  if (!ioPromise) {
    ioPromise = (async () => {
      await MeshoptEncoder.ready
      return new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
    })()
  }
  return ioPromise
}

/** Optimizes and compresses the document, returning GLB bytes. */
export async function toGlb(builder) {
  const nodeIO = await io()
  await builder.doc.transform(
    dedup({ keepUniqueNames: true }),
    weld(),
    // Anchors are empty leaves and the face's UVs have no texture yet: keep both.
    prune({ keepLeaves: true, keepAttributes: true }),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  )
  return nodeIO.writeBinary(builder.doc)
}
