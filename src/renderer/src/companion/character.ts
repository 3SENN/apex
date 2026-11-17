/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as THREE from 'three'
import { FACE_CANVAS, PART_SLOTS, RIG_NODES, SLOT_ANCHOR, TINTS, type CompanionLook, type LookAdjust, type LookAdjustKey, type PartSlot, type Tint } from '@shared/companion'
import { modelKey, outlineColor } from '@shared/companionLogic'
import { loadModel, type CompanionAssets, type LoadedModel } from './assets'
import { EYE_CENTERS, type Bounds } from './layout'
import { motionClips } from './locomotion'
import { createOutlineMaterial, createToonGradient, createToonMaterial, isFaceMaterial, setOutline, tintOf, wantsOutline } from './materials'
import { reportCompanionError } from './stats'

/** One assembled companion: a rig clone with its parts, owning its materials and geometries but not the shared vertex data. */
export interface Character {
  root: THREE.Group
  /** Mixer root; clips target its node names. */
  rig: THREE.Object3D
  clips: Map<string, THREE.AnimationClip>
  headPivot: THREE.Object3D | null
  body: THREE.Object3D | null
  /** The node that moves when the companion hops, for the ground shadow. */
  rigRoot: THREE.Object3D | null
  prop: THREE.Object3D | null
  /** Rest-pose bounds, for framing. */
  bounds: Bounds
  /** Rest-pose bounds of the head with everything worn on it, for portrait framing. */
  headBounds: Bounds
  /** Rest-pose bounds of the bare head, without hair, hats or ears. */
  skullBounds: Bounds
  /** World height of the eye line at rest; null when the face layer is missing. */
  eyeY: number | null
  modelKey: string
  setColors(colors: Record<Tint, string>): void
  setOutlineThickness(world: number): void
  /** Hides everything but the head and what is worn on it (face-only stills). */
  setBodyVisible(visible: boolean): void
  /** Frees it; with `keepMaterials`, its materials go there instead, for the caller to dispose later (render.ts keeps their shader programs warm). */
  dispose(keepMaterials?: THREE.Material[]): void
}

/** The face canvas row of the eye line, as a texture v (UVs run bottom to top). */
const EYE_V = 1 - EYE_CENTERS[0][1] / FACE_CANVAS.height

/** World height of the face layer's eye line: the vertices whose v is nearest it. */
function eyeLine(mesh: THREE.Mesh | null): number | null {
  const uv = mesh?.geometry.getAttribute('uv')
  const position = mesh?.geometry.getAttribute('position')
  if (!mesh || !uv || !position) return null
  let best = Infinity
  for (let i = 0; i < uv.count; i++) best = Math.min(best, Math.abs(uv.getY(i) - EYE_V))
  if (!Number.isFinite(best)) return null
  const point = new THREE.Vector3()
  let sum = 0
  let n = 0
  for (let i = 0; i < uv.count; i++) {
    if (Math.abs(uv.getY(i) - EYE_V) > best + 1e-4) continue
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)
    sum += point.y
    n++
  }
  return n > 0 ? sum / n : null
}

/** glTF node names as authored; three.js strips '.', ':' and '/' from `name`. */
function authoredName(object: THREE.Object3D): string {
  const original = object.userData.name
  return typeof original === 'string' ? original : object.name
}

export function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(name)
  const stack: THREE.Object3D[] = [root]
  while (stack.length > 0) {
    const object = stack.shift() as THREE.Object3D
    if (authoredName(object) === name || object.name === sanitized) return object
    stack.push(...object.children)
  }
  return null
}

const RIG_TRACK_NAMES = new Set(RIG_NODES.map((n) => THREE.PropertyBinding.sanitizeNodeName(n)))

/** Parts must not shadow rig node names, or the mixer could bind a clip to them. */
function avoidRigNames(part: THREE.Object3D): void {
  part.traverse((object) => {
    if (RIG_TRACK_NAMES.has(object.name)) object.name = `${object.name}_part`
  })
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

/**
 * A geometry of this character's own over a cached template's attributes.
 * A renderer adds a dispose listener to every geometry it draws, and only
 * `geometry.dispose()` removes it; drawing the template geometries would tie
 * every renderer (and its GL context) to the module-level model cache for
 * good. Disposing the wrapper frees that renderer's buffers and lets it go,
 * while the attribute data stays shared.
 */
function wrapGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.name = source.name
  geometry.setIndex(source.index)
  for (const [name, attribute] of Object.entries(source.attributes)) geometry.setAttribute(name, attribute)
  geometry.morphAttributes = { ...source.morphAttributes }
  geometry.morphTargetsRelative = source.morphTargetsRelative
  for (const group of source.groups) geometry.addGroup(group.start, group.count, group.materialIndex)
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count)
  geometry.boundingBox = source.boundingBox?.clone() ?? null
  geometry.boundingSphere = source.boundingSphere?.clone() ?? null
  return geometry
}

const ACCESSORY_SLOTS: ReadonlySet<PartSlot> = new Set<PartSlot>(['hat', 'eyeAccessory', 'earAccessory'])

/** DS-120 rig adjustments in the head's local units (the bare head is about one unit tall). */
export function rigTweaks(adjust: LookAdjust | undefined): { headScale: number; earLift: number; accessoryScale: number; accessoryLift: number } {
  const v = (key: LookAdjustKey): number => adjust?.[key] ?? 0
  return {
    headScale: 1 + v('headSize') * 0.15,
    earLift: v('earHeight') * 0.08,
    accessoryScale: 1 + v('accessorySize') * 0.2,
    accessoryLift: v('accessoryHeight') * 0.06,
  }
}

export async function buildCharacter(look: CompanionLook, assets: CompanionAssets, faceTexture: THREE.Texture): Promise<Character> {
  const { manifest } = assets
  const rigDef = manifest.rigs[look.rig]
  if (!rigDef) throw new Error(`rig ${look.rig} is missing from the manifest`)
  const headId = look.parts.head as string
  const slots = PART_SLOTS.filter((slot) => look.parts[slot] !== null)
  const rigLoad = loadModel(rigDef.file)
  const loads = await Promise.allSettled(
    slots.map((slot) => {
      const id = look.parts[slot] as string
      const def = manifest.parts[id]
      if (!def) return Promise.reject(new Error(`part ${id} is missing from the manifest`))
      return loadModel(def.file)
    }),
  )
  const rigModel = await rigLoad
  // A missing accessory only drops that part; a missing head is fatal.
  const models = new Map<PartSlot, LoadedModel>()
  for (const [i, result] of loads.entries()) {
    const slot = slots[i] as PartSlot
    if (result.status === 'fulfilled') {
      models.set(slot, result.value)
      continue
    }
    if (slot === 'head') throw result.reason
    reportCompanionError(`${look.parts[slot]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
  }

  const rig = rigModel.scene.clone(true)
  const root = new THREE.Group()
  root.name = 'companion'
  root.add(rig)

  const headModel = models.get('head')
  if (!headModel) throw new Error(`head ${headId} did not load`)
  const head = headModel.scene.clone(true)
  avoidRigNames(head)
  const headAnchor = findNode(rig, 'anchor:head') ?? findNode(rig, 'head-pivot') ?? rig
  // DS-120: head size scales the head and everything worn on it, about its seat.
  const tweak = rigTweaks(look.adjust)
  if (tweak.headScale !== 1) head.scale.multiplyScalar(tweak.headScale)
  headAnchor.add(head)
  // The bare head, measured before anything is worn on it.
  root.updateMatrixWorld(true)
  const skullBox = new THREE.Box3().setFromObject(head)

  let prop: THREE.Object3D | null = null
  for (const slot of slots) {
    if (slot === 'head') continue
    const model = models.get(slot)
    if (!model) continue
    const id = look.parts[slot] as string
    const part = model.scene.clone(true)
    avoidRigNames(part)
    const anchorName = `anchor:${SLOT_ANCHOR[slot]}`
    const anchor = findNode(head, anchorName) ?? findNode(rig, anchorName) ?? (slot === 'prop' ? findNode(rig, 'arm.R') : head) ?? head
    // Hats and headphones sit on the hair when there is some, so hair can replace the head's seat.
    const seat = assets.hats[id]?.[headId]
    const adjust = (look.parts.hair !== null ? seat?.hair?.[look.parts.hair] : undefined) ?? seat
    if (adjust) {
      part.position.fromArray(adjust.offset)
      part.rotation.set(adjust.rotation[0], adjust.rotation[1], adjust.rotation[2])
      part.scale.setScalar(adjust.scale)
    }
    // DS-120: ears move up or down; accessories (hat, glasses, earrings) grow and move.
    if (slot === 'ears') part.position.y += tweak.earLift
    else if (ACCESSORY_SLOTS.has(slot)) {
      part.scale.multiplyScalar(tweak.accessoryScale)
      part.position.y += tweak.accessoryLift
    }
    anchor.add(part)
    if (slot === 'prop') prop = part
  }

  // ---- materials ----
  const gradient = createToonGradient()
  const outline = createOutlineMaterial(outlineColor(look.colors.skin), 0.02)
  const byTint = new Map<Tint, THREE.MeshToonMaterial[]>()
  const owned: THREE.Material[] = [outline]
  const converted = new Map<string, THREE.Material>()
  const faceMaterial = new THREE.MeshBasicMaterial({
    name: 'face',
    map: faceTexture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  })
  owned.push(faceMaterial)

  const convert = (source: THREE.Material, mesh: THREE.Mesh): THREE.Material => {
    if (isFaceMaterial(source) || authoredName(mesh) === 'face') return faceMaterial
    const hit = converted.get(source.uuid)
    if (hit) return hit
    const tint = tintOf(source)
    const material = createToonMaterial(source, gradient, tint ? look.colors[tint] : null)
    if (tint) byTint.set(tint, [...(byTint.get(tint) ?? []), material])
    converted.set(source.uuid, material)
    owned.push(material)
    return material
  }

  const meshes: THREE.Mesh[] = []
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh)
  })
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>()
  for (const mesh of meshes) {
    let geometry = geometries.get(mesh.geometry)
    if (!geometry) {
      geometry = wrapGeometry(mesh.geometry)
      geometries.set(mesh.geometry, geometry)
    }
    mesh.geometry = geometry
    const sources = materialsOf(mesh)
    const materials = sources.map((m) => convert(m, mesh))
    mesh.material = Array.isArray(mesh.material) ? materials : (materials[0] as THREE.Material)
    if (mesh.material === faceMaterial) {
      mesh.renderOrder = 1
      continue
    }
    if (sources.every(wantsOutline)) {
      const hull = new THREE.Mesh(mesh.geometry, outline)
      hull.name = 'outline'
      hull.raycast = () => {}
      mesh.add(hull)
    }
  }

  root.updateMatrixWorld(true)
  const toBounds = (box: THREE.Box3): Bounds => ({ min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] })
  const bounds = toBounds(new THREE.Box3().setFromObject(root))
  const headBounds = toBounds(new THREE.Box3().setFromObject(head))
  const skullBounds = skullBox.isEmpty() ? headBounds : toBounds(skullBox)
  let faceMesh: THREE.Mesh | null = null
  head.traverse((object) => {
    if (!faceMesh && (object as THREE.Mesh).isMesh && (object as THREE.Mesh).material === faceMaterial) faceMesh = object as THREE.Mesh
  })
  const eyeY = eyeLine(faceMesh)
  const outsideHead = meshes.filter((mesh) => {
    for (let node: THREE.Object3D | null = mesh; node; node = node.parent) if (node === head) return false
    return true
  })

  const clips = new Map(rigModel.animations.map((clip) => [clip.name, clip] as const))
  if (clips.size === 0) reportCompanionError(`${rigDef.file}: no animation clips`)
  // Walk and run, posed from the rig's rest pose and shared by every character on it.
  for (const [id, clip] of motionClips(rigModel.scene)) clips.set(id, clip)

  return {
    root,
    rig,
    clips,
    headPivot: findNode(rig, 'head-pivot'),
    body: findNode(rig, 'body'),
    rigRoot: findNode(rig, 'root'),
    prop,
    bounds,
    headBounds,
    skullBounds,
    eyeY,
    modelKey: modelKey(look),
    setColors(colors) {
      for (const tint of TINTS) for (const material of byTint.get(tint) ?? []) material.color.set(colors[tint])
      setOutline(outline, outlineColor(colors.skin), null)
    },
    setOutlineThickness(world) {
      setOutline(outline, null, world)
    },
    setBodyVisible(visible) {
      for (const mesh of outsideHead) mesh.visible = visible
    },
    dispose(keepMaterials) {
      root.removeFromParent()
      if (keepMaterials) keepMaterials.push(...owned)
      else for (const material of owned) material.dispose()
      gradient.dispose()
      // Frees the shared attributes' buffers in the renderers that drew this
      // character, so a character must be disposed before another one sharing
      // those attributes is first drawn in the same renderer (view and
      // off-screen renders each draw one character at a time).
      for (const geometry of geometries.values()) geometry.dispose()
    },
  }
}
