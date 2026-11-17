/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeIO, type Document, type Node } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import { beforeAll, describe, expect, it } from 'vitest'
import { BRANDING } from '@shared/branding'
import {
  ANCHORS,
  BROW_VARIANTS,
  CLIPS,
  COMPANION_MOODS,
  DEFAULT_LOOK,
  EYE_VARIANTS,
  FACE_IDS,
  FACE_LAYERS,
  MOOD_CLIP,
  MOOD_FACE,
  MOUTH_VARIANTS,
  ONE_SHOT_CLIPS,
  PART_IDS,
  PART_SLOTS,
  RIG_NODES,
  RIGS,
  TINTS,
  type AnimationEventsConfig,
  type CompanionLook,
  type CompanionManifest,
  type CompanionPreset,
  type CompatibilityConfig,
  type EyeVariant,
  type FaceLayer,
  type HatConfig,
  type PartAdjustment,
  type PartSlot,
  type PupilConfig,
  type RandomizationConfig,
} from '../src/shared/companion'
import { moodGaze } from '../src/shared/companionLogic'
import { EYE_CENTERS, pupilOffset } from '../src/renderer/src/companion/layout'
import { outlinePoints, painted, parseLayer } from './svgCoverage'

// Checks the generated companion assets (scripts/companion-assets) against
// the contract in src/shared/companion.ts and docs/companion-system.md.

const ROOT = fileURLToPath(new URL('../src/renderer/public/companion/', import.meta.url))
const read = (rel: string): Buffer => readFileSync(join(ROOT, rel))
const readJson = <T>(rel: string): T => JSON.parse(read(rel).toString('utf8')) as T

const manifest = readJson<CompanionManifest>('manifest.json')
const compat = readJson<CompatibilityConfig>(manifest.config.compatibility)
const hats = readJson<HatConfig>(manifest.config.hats)
const pupils = readJson<PupilConfig>(manifest.config.pupils)
const randomization = readJson<RandomizationConfig>(manifest.config.randomization)
const events = readJson<AnimationEventsConfig>(manifest.config.animationEvents)
const presets = readJson<CompanionPreset[]>(manifest.config.presets)

const VARIANTS: Record<FaceLayer, readonly string[]> = { eyes: EYE_VARIANTS, brows: BROW_VARIANTS, mouth: MOUTH_VARIANTS }
const RULE_SLOTS = ['ears', 'hair', 'hat', 'eyeAccessory', 'earAccessory'] as const
const MATERIAL = /^(tint:(skin|hair|accent|outfit)|paint:[a-z0-9-]+)$/
const HEX = /^#[0-9a-f]{6}$/

const sorted = (values: Iterable<string>): string[] => [...values].sort()
const isPart = (slot: PartSlot, id: string): boolean => (PART_IDS[slot] as readonly string[]).includes(id)
const isFace = (layer: FaceLayer, id: string): boolean => (FACE_IDS[layer] as readonly string[]).includes(id)

let io: NodeIO
const docs = new Map<string, Document>()
async function glb(rel: string): Promise<Document> {
  let doc = docs.get(rel)
  if (!doc) {
    doc = await io.readBinary(new Uint8Array(read(rel)))
    docs.set(rel, doc)
  }
  return doc
}

function findNode(doc: Document, name: string): Node | undefined {
  return doc.getRoot().listNodes().find((n) => n.getName() === name)
}

function descendants(node: Node): Node[] {
  return node.listChildren().flatMap((c) => [c, ...descendants(c)])
}

function materialNames(doc: Document, root?: Node): string[] {
  const nodes = root ? [root, ...descendants(root)] : doc.getRoot().listNodes()
  const names = new Set<string>()
  for (const n of nodes) for (const p of n.getMesh()?.listPrimitives() ?? []) names.add(p.getMaterial()?.getName() ?? '(none)')
  return sorted(names)
}

/** Cosine of the angle between two rotations; meshopt's 16-bit quaternions are not exactly unit length. */
function quatDot(a: number[], b: number[]): number {
  const len = (q: number[]): number => Math.hypot(...q) || 1
  return Math.abs(a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0)) / (len(a) * len(b))
}

function triangles(doc: Document): number {
  let count = 0
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) count += (p.getIndices()?.getCount() ?? 0) / 3
  return count
}

/** Whether a look obeys the head rules and, for a worn hat, the hat's hair rules. */
function lookAllowed(look: CompanionLook): boolean {
  const head = look.parts.head
  if (!head || !isPart('head', head)) return false
  for (const slot of RULE_SLOTS) {
    const id = look.parts[slot]
    if (id === null) continue
    if (!isPart(slot, id)) return false
    for (const key of [head, look.parts.hat]) {
      const rule = key ? compat[key]?.[slot] : undefined
      if (rule !== undefined && rule !== 'all' && !rule.includes(id)) return false
    }
  }
  return look.parts.prop === null || isPart('prop', look.parts.prop)
}

beforeAll(async () => {
  await MeshoptDecoder.ready
  io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
})

describe('companion manifest', () => {
  it('covers exactly the rigs, parts and face ids of the contract', () => {
    expect(manifest.version).toBe(1)
    expect(sorted(Object.keys(manifest.rigs))).toEqual(sorted(RIGS))
    expect(sorted(Object.keys(manifest.parts))).toEqual(sorted(PART_SLOTS.flatMap((s) => [...PART_IDS[s]])))
    for (const slot of PART_SLOTS) {
      for (const id of PART_IDS[slot]) {
        const part = manifest.parts[id]
        expect(part?.slot, id).toBe(slot)
        expect(part?.label.length, id).toBeGreaterThan(0)
        expect(part?.file, id).toBe(`parts/${id}.glb`)
        for (const tint of part?.tints ?? []) expect(TINTS).toContain(tint)
      }
    }
    for (const layer of FACE_LAYERS) expect(sorted(Object.keys(manifest.face[layer]))).toEqual(sorted(FACE_IDS[layer]))
    for (const rig of RIGS) expect(manifest.rigs[rig].label.length).toBeGreaterThan(0)
  })

  it('references only files that exist, and nothing else is shipped', () => {
    const referenced = new Set<string>(['manifest.json', ...Object.values(manifest.config)])
    for (const rig of Object.values(manifest.rigs)) referenced.add(rig.file)
    for (const part of Object.values(manifest.parts)) referenced.add(part.file)
    for (const layer of FACE_LAYERS) {
      for (const def of Object.values(manifest.face[layer])) {
        for (const file of Object.values(def.variants)) referenced.add(file)
        if (def.pupils) referenced.add(def.pupils)
      }
    }
    for (const file of referenced) expect(statSync(join(ROOT, file)).isFile(), file).toBe(true)
    // Manifest entries use / on every platform.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [relative(ROOT, join(dir, e.name)).split(sep).join('/')]))
    // Besides them, only the licence notice the art travels with (ART-LICENSE.md).
    expect(sorted(walk(ROOT))).toEqual(sorted([...referenced, 'LICENSE.md']))
    expect(readFileSync(join(ROOT, 'LICENSE.md'), 'utf8')).toMatch(/Atelier Companion Art License/)
  })

  it('gives every face part every variant, and eyes their pupils', () => {
    for (const layer of FACE_LAYERS) {
      for (const [id, def] of Object.entries(manifest.face[layer])) {
        expect(sorted(Object.keys(def.variants)), id).toEqual(sorted(VARIANTS[layer]))
        for (const [variant, file] of Object.entries(def.variants)) expect(file).toBe(`face/${id}/${variant}.svg`)
        if (layer === 'eyes') {
          expect(def.pupils).toBe(`face/${id}/pupils.svg`)
          expect(def.pupilVariants?.length).toBeGreaterThan(0)
          for (const v of def.pupilVariants ?? []) expect(EYE_VARIANTS).toContain(v)
          // Closed eyes never show pupils.
          for (const v of ['blink', 'happy', 'sleepy'] as const) expect(def.pupilVariants).not.toContain(v)
        } else {
          expect(def.pupils).toBeUndefined()
        }
      }
    }
  })

  it('draws every face layer on a transparent 512×256 canvas in the face palette', () => {
    const allowed = new Set(['#1d1630', '#ffffff', '#4a1f3a'])
    for (const layer of FACE_LAYERS) {
      for (const def of Object.values(manifest.face[layer])) {
        for (const file of [...Object.values(def.variants), ...(def.pupils ? [def.pupils] : [])]) {
          const svg = read(file).toString('utf8')
          expect(svg, file).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="256" viewBox="0 0 512 256">/)
          expect(svg, file).not.toMatch(/<rect|<image|<text/)
          for (const color of svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) expect(allowed, `${file} ${color}`).toContain(color.toLowerCase())
        }
      }
    }
  })
})

describe('companion models', () => {
  it('builds each rig with the spec hierarchy and anchors', async () => {
    for (const rig of RIGS) {
      const doc = await glb(manifest.rigs[rig].file)
      expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression')
      const parent = (name: string): string | undefined => findNode(doc, name)?.getParentNode()?.getName()
      for (const name of RIG_NODES) expect(findNode(doc, name), `${rig} ${name}`).toBeDefined()
      expect(findNode(doc, 'root')?.getParentNode()).toBeNull()
      expect(parent('body')).toBe('root')
      expect(parent('head-pivot')).toBe('body')
      expect(parent('anchor:head')).toBe('head-pivot')
      expect(parent('arm.L')).toBe('body')
      expect(parent('arm.R')).toBe('body')
      expect(parent('anchor:prop')).toBe('arm.R')
      expect(parent('foot.L')).toBe('root')
      expect(parent('foot.R')).toBe('root')
      expect(findNode(doc, 'anchor:head')?.getMesh()).toBeNull()
      // Feet stand on the ground.
      expect(findNode(doc, 'root')?.getTranslation()[1]).toBe(0)
      for (const mat of materialNames(doc)) expect(mat).toMatch(MATERIAL)
      expect(materialNames(doc)).toEqual(expect.arrayContaining(['tint:skin', 'tint:outfit', 'tint:accent']))
    }
  })

  it('gives each rig every clip, animating only rig nodes, with seamless loops and rest-to-rest one-shots', async () => {
    for (const rig of RIGS) {
      const doc = await glb(manifest.rigs[rig].file)
      const anims = doc.getRoot().listAnimations()
      expect(sorted(anims.map((a) => a.getName())), rig).toEqual(sorted(CLIPS))
      for (const anim of anims) {
        const clip = anim.getName()
        const oneShot = ONE_SHOT_CLIPS.includes(clip as (typeof CLIPS)[number])
        let duration = 0
        for (const channel of anim.listChannels()) {
          const node = channel.getTargetNode()
          const path = channel.getTargetPath()
          expect(RIG_NODES as readonly string[], `${rig} ${clip}`).toContain(node?.getName())
          expect(['translation', 'rotation', 'scale']).toContain(path)
          const sampler = channel.getSampler()
          const input = sampler?.getInput()
          const output = sampler?.getOutput()
          if (!node || !input || !output) throw new Error(`${rig} ${clip}: incomplete channel`)
          const last = input.getCount() - 1
          duration = Math.max(duration, input.getMax([])[0] ?? 0)
          const first = output.getElement(0, [])
          const end = output.getElement(last, [])
          if (oneShot) {
            const rest = path === 'translation' ? node.getTranslation() : path === 'rotation' ? node.getRotation() : node.getScale()
            const restDiff = (v: number[]): number =>
              path === 'rotation' ? 1 - quatDot(v, [...rest]) : Math.max(...v.map((x, i) => Math.abs(x - (rest[i] ?? 0))))
            expect(restDiff(first), `${rig} ${clip} ${node.getName()} ${path} start`).toBeLessThan(2e-3)
            expect(restDiff(end), `${rig} ${clip} ${node.getName()} ${path} end`).toBeLessThan(2e-3)
          } else if (path === 'rotation') {
            expect(quatDot(first, end), `${rig} ${clip} ${node.getName()}`).toBeGreaterThan(0.99999)
          } else {
            first.forEach((x, i) => expect(Math.abs(x - (end[i] ?? 0)), `${rig} ${clip} ${node.getName()} ${path}`).toBeLessThan(1e-3))
          }
        }
        if (oneShot) {
          expect(duration, `${rig} ${clip}`).toBeGreaterThanOrEqual(1)
          expect(duration, `${rig} ${clip}`).toBeLessThanOrEqual(1.5)
        } else {
          expect(duration, `${rig} ${clip}`).toBeGreaterThanOrEqual(2)
          expect(duration, `${rig} ${clip}`).toBeLessThanOrEqual(4)
        }
      }
    }
  })

  it('builds heads with a UV-mapped face surface and every head anchor', async () => {
    for (const id of PART_IDS.head) {
      const doc = await glb(manifest.parts[id]?.file ?? '')
      const root = findNode(doc, id)
      expect(root, id).toBeDefined()
      if (!root) continue
      const names = descendants(root).map((n) => n.getName())
      for (const anchor of ANCHORS.filter((a) => a !== 'head' && a !== 'prop')) expect(names, id).toContain(`anchor:${anchor}`)
      const face = descendants(root).find((n) => n.getMesh()?.getName() === 'face')
      const prim = face?.getMesh()?.listPrimitives()[0]
      expect(prim?.getMaterial()?.getName(), id).toBe('face')
      const uv = prim?.getAttribute('TEXCOORD_0')
      expect(uv, id).toBeTruthy()
      // Decoded values (min/max hold the raw quantized integers).
      const us: number[] = [], vs: number[] = []
      for (let i = 0; i < (uv?.getCount() ?? 0); i++) {
        const [u = NaN, v = NaN] = uv?.getElement(i, []) ?? []
        us.push(u)
        vs.push(v)
      }
      for (const v of [...us, ...vs]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // The face covers the eyes and mouth region of the canvas.
      expect(Math.min(...us), id).toBeLessThan(0.25)
      expect(Math.max(...us), id).toBeGreaterThan(0.75)
      expect(Math.min(...vs), id).toBeLessThan(0.15)
      expect(Math.max(...vs), id).toBeGreaterThan(0.85)
      expect(materialNames(doc, root)).toEqual(['face', 'tint:skin'])
      expect(manifest.parts[id]?.tints).toEqual(['skin'])
      const tris = triangles(doc)
      expect(tris, id).toBeGreaterThan(2000)
      expect(tris, id).toBeLessThan(4500)
    }
  })

  it('names every other part after its id and uses only tint and paint materials', async () => {
    for (const slot of PART_SLOTS.filter((s) => s !== 'head')) {
      for (const id of PART_IDS[slot]) {
        const doc = await glb(manifest.parts[id]?.file ?? '')
        const top = doc.getRoot().getDefaultScene()?.listChildren() ?? []
        expect(top.map((n) => n.getName()), id).toEqual([id])
        const mats = materialNames(doc)
        for (const m of mats) expect(m, id).toMatch(MATERIAL)
        const tints = TINTS.filter((t) => mats.includes(`tint:${t}`))
        expect(manifest.parts[id]?.tints, id).toEqual(tints)
        expect(doc.getRoot().listAnimations()).toHaveLength(0)
        expect(triangles(doc), id).toBeLessThan(4500)
      }
    }
  })

  it('stays within the size budgets', () => {
    for (const rig of Object.values(manifest.rigs)) expect(statSync(join(ROOT, rig.file)).size, rig.file).toBeLessThan(150 * 1024)
    for (const part of Object.values(manifest.parts)) expect(statSync(join(ROOT, part.file)).size, part.file).toBeLessThan(60 * 1024)
  })
})

describe('companion configs', () => {
  it('lists head rules for every head and hat rules only for hats, with valid ids', () => {
    for (const head of PART_IDS.head) expect(compat[head], head).toBeDefined()
    for (const [key, rules] of Object.entries(compat)) {
      expect(isPart('head', key) || isPart('hat', key), key).toBe(true)
      expect(sorted(Object.keys(rules))).toEqual(sorted(RULE_SLOTS))
      for (const slot of RULE_SLOTS) {
        const rule = rules[slot]
        if (rule === 'all') continue
        for (const id of rule) expect(isPart(slot, id), `${key} ${slot} ${id}`).toBe(true)
      }
    }
    // Tall hair would poke through a beanie; the side-swept fringe cuts through a cuff or a brim.
    expect(compat['hat-beanie']?.hair).not.toContain('hair-mohawk')
    for (const hat of ['hat-beanie', 'hat-cap']) expect(compat[hat]?.hair, hat).not.toContain('hair-sideswept')
  })

  it('seats every hat and the headphones on every head, with valid hair replacements', () => {
    expect(sorted(Object.keys(hats))).toEqual(sorted([...PART_IDS.hat, 'headphones']))
    const check = (adj: PartAdjustment, limit: number): void => {
      expect(adj.offset).toHaveLength(3)
      expect(adj.rotation).toHaveLength(3)
      for (const v of [...adj.offset, ...adj.rotation]) expect(Math.abs(v)).toBeLessThan(limit)
      expect(adj.scale).toBeGreaterThan(0.75)
      expect(adj.scale).toBeLessThan(1.31)
    }
    for (const [part, perHead] of Object.entries(hats)) {
      expect(sorted(Object.keys(perHead)), part).toEqual(sorted(PART_IDS.head))
      for (const { hair, ...adj } of Object.values(perHead)) {
        check(adj, 0.5)
        for (const [hairId, replacement] of Object.entries(hair ?? {})) {
          expect(isPart('hair', hairId), `${part} ${hairId}`).toBe(true)
          // Hair the hat does not accept never needs a seat.
          if (isPart('hat', part)) expect(compat[part]?.hair === undefined || compat[part]?.hair === 'all' || compat[part]?.hair.includes(hairId)).toBe(true)
          check(replacement, 0.65)
        }
      }
    }
    // Thick hair lifts a crown above where it sits on the bare head.
    const drop = hats['hat-crown']?.['head-drop']
    expect(drop?.hair?.['hair-bob']?.offset[1]).toBeGreaterThan(drop?.offset[1] ?? 0)
    expect(hats.headphones?.['head-round']?.hair?.['hair-bob']?.scale).toBeGreaterThan(1)
  })

  it('sets pupil movement for every eye style', () => {
    expect(sorted(Object.keys(pupils))).toEqual(sorted(FACE_IDS.eyes))
    for (const config of Object.values(pupils)) {
      expect(config.rangeX).toBeGreaterThan(0)
      expect(config.rangeX).toBeLessThan(0.08)
      expect(config.rangeY).toBeGreaterThan(0)
      expect(config.rangeY).toBeLessThan(0.08)
      expect(config.scale).toBeGreaterThan(0)
    }
  })

  it('keeps pupils on the whites at every gaze the runtime shows them with', () => {
    const steps = [-1, -0.5, 0, 0.5, 1]
    const cueEyes = (clip: (typeof CLIPS)[number]): EyeVariant[] =>
      events[clip].flatMap((e) => (e.type === 'expression' && e.face.eyes ? [e.face.eyes] : []))
    // Poke and wave can play over any mood.
    const oneShotEyes = ONE_SHOT_CLIPS.flatMap(cueEyes)
    for (const [id, def] of Object.entries(manifest.face.eyes)) {
      if (!def.pupils) continue
      const pupilEdge = outlinePoints(parseLayer(read(def.pupils).toString('utf8')))
      const shown = def.pupilVariants ?? ['neutral', 'focused', 'wide', 'sad']
      // Each eye variant with every pupil offset it can be drawn with.
      const offsets = new Map<EyeVariant, Map<string, string>>()
      for (const mood of COMPANION_MOODS) {
        const variants = new Set<EyeVariant>([MOOD_FACE[mood].eyes, ...cueEyes(MOOD_CLIP[mood]), ...oneShotEyes])
        for (const variant of [...variants].filter((v) => shown.includes(v))) {
          const seen = offsets.get(variant) ?? new Map<string, string>()
          offsets.set(variant, seen)
          for (const x of steps) {
            for (const y of steps) {
              const { dx, dy } = pupilOffset(moodGaze(mood, { x, y }), pupils[id])
              if (!seen.has(`${dx},${dy}`)) seen.set(`${dx},${dy}`, `${mood}, pointer ${x},${y}`)
            }
          }
        }
      }
      for (const [variant, seen] of offsets) {
        const file = def.variants[variant] ?? ''
        const eye = parseLayer(read(file).toString('utf8'))
        // Without whites under it at rest, the pupil is drawn on the skin by design (dot eyes).
        if (!EYE_CENTERS.every(([x, y]) => painted([x, y], eye.filter((shape) => shape.filled)))) continue
        for (const [offset, when] of seen) {
          const [dx = 0, dy = 0] = offset.split(',').map(Number)
          // The pupil may cover the outline, but no pixel may reach the skin.
          const outside = pupilEdge.filter(([px, py]) => !painted([px + dx, py + dy], eye, 0.25))
          expect(outside.length, `${file} in ${when}`).toBe(0)
        }
      }
    }
  })

  it('randomizes only over valid ids, with named palettes', () => {
    for (const r of randomization.rig) expect(RIGS).toContain(r.id)
    for (const slot of PART_SLOTS) {
      const options = randomization.slots[slot]
      expect(options.length, slot).toBeGreaterThan(0)
      for (const o of options) {
        if (o.id === null) expect(slot).not.toBe('head')
        else expect(isPart(slot, o.id), `${slot} ${o.id}`).toBe(true)
        expect(o.weight).toBeGreaterThan(0)
      }
    }
    for (const layer of FACE_LAYERS) for (const o of randomization.face[layer]) expect(isFace(layer, o.id), o.id).toBe(true)
    expect(randomization.palettes.length).toBeGreaterThanOrEqual(8)
    expect(new Set(randomization.palettes.map((p) => p.name)).size).toBe(randomization.palettes.length)
    for (const p of randomization.palettes) for (const t of TINTS) expect(p.colors[t], p.name).toMatch(HEX)
  })

  it('times animation events inside each clip with valid expressions', async () => {
    expect(sorted(Object.keys(events))).toEqual(sorted(CLIPS))
    const doc = await glb(manifest.rigs.A.file)
    for (const clip of CLIPS) {
      const anim = doc.getRoot().listAnimations().find((a) => a.getName() === clip)
      const duration = Math.max(...(anim?.listSamplers().map((s) => s.getInput()?.getMax([])[0] ?? 0) ?? [0]))
      expect(events[clip].length, clip).toBeGreaterThan(0)
      for (const e of events[clip]) {
        expect(e.t, clip).toBeGreaterThanOrEqual(0)
        expect(e.t, clip).toBeLessThanOrEqual(duration)
        if (e.type === 'expression') {
          expect(e.duration).toBeGreaterThan(0)
          if (e.face.eyes) expect(EYE_VARIANTS).toContain(e.face.eyes)
          if (e.face.brows) expect(BROW_VARIANTS).toContain(e.face.brows)
          if (e.face.mouth) expect(MOUTH_VARIANTS).toContain(e.face.mouth)
        } else if (e.type === 'squash') {
          expect(e.amount).toBeGreaterThan(0)
          expect(e.amount).toBeLessThan(0.5)
        } else {
          expect(['blink', 'sparkle', 'prop']).toContain(e.type)
        }
      }
    }
  })

  it('ships six presets with compatible looks, Pip first', () => {
    expect(presets).toHaveLength(6)
    expect(new Set(presets.map((p) => p.id)).size).toBe(6)
    expect(presets[0]?.id).toBe('pip')
    // Official Atelier's default look is Pip's (the unofficial branding has a neutral companion of its own).
    if (BRANDING.official) expect(presets[0]?.look).toEqual(DEFAULT_LOOK)
    for (const p of presets) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.tagline.length).toBeGreaterThan(0)
      const sentences = p.personality.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 0)
      expect(sentences.length, p.id).toBeLessThanOrEqual(2)
      expect(RIGS).toContain(p.look.rig)
      expect(sorted(Object.keys(p.look.parts))).toEqual(sorted(PART_SLOTS))
      expect(lookAllowed(p.look), p.id).toBe(true)
      for (const layer of FACE_LAYERS) expect(isFace(layer, p.look.face[layer]), `${p.id} ${layer}`).toBe(true)
      for (const t of TINTS) expect(p.look.colors[t]).toMatch(HEX)
    }
  })
})

interface GeneratorPart {
  file: string
  builder: unknown
}

describe('companion generator', () => {
  it('reproduces the committed assets byte for byte', async () => {
    const lib = (name: string): Promise<Record<string, unknown>> =>
      import(/* @vite-ignore */ new URL(`../scripts/companion-assets/lib/${name}.mjs`, import.meta.url).href) as Promise<Record<string, unknown>>
    const { buildParts } = (await lib('parts')) as { buildParts: () => GeneratorPart[] }
    const { toGlb } = (await lib('gltf')) as { toGlb: (builder: unknown) => Promise<Uint8Array> }
    const { faceFiles } = (await lib('face-svg')) as { faceFiles: () => { files: Record<string, string> } }
    const { buildConfigs } = (await lib('configs')) as { buildConfigs: (input: { parts: GeneratorPart[] }) => { files: Record<string, unknown> } }
    const parts = buildParts()
    for (const part of parts.filter((p) => /head-round|hat-crown|hair-bob|prop-coffee/.test(p.file))) {
      expect(Buffer.from(await toGlb(part.builder)).equals(read(part.file)), part.file).toBe(true)
    }
    for (const [file, svg] of Object.entries(faceFiles().files)) expect(svg, file).toBe(read(file).toString('utf8'))
    for (const [file, value] of Object.entries(buildConfigs({ parts }).files)) expect(`${JSON.stringify(value, null, 2)}\n`, file).toBe(read(file).toString('utf8'))
  }, 120_000)
})
