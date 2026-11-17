/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-kit/world.js (docs/apps.md › Worlds): a world file as a three.js
// scene. The ground is one mesh of coloured tiles on an earth base, so the
// world reads as a diorama; props come from atelier-kit/props.js; places get an
// outline and a floating name; the sky sets the background, the fog and the
// light. Scene units are tiles: x runs 0..width, z runs 0..depth, y is up.
// The app adds `root` and `lights` to its scene, sets `scene.background` and
// `scene.fog` from `sky`, and calls `rebuild(world)` after an edit.
import * as THREE from 'three'
import { groundAt, type WorldDoc, type WorldSky } from '@shared/worlds'
import { PALETTES, prop } from './props'

export interface SkyLook {
  background: string
  hemiSky: string
  hemiGround: string
  hemi: number
  sun: string
  sunIntensity: number
  /** Where the light comes from, as a direction. */
  sunFrom: [number, number, number]
}

export const SKIES: Record<WorldSky, SkyLook> = {
  morning: { background: '#c4e8ff', hemiSky: '#e3f4ff', hemiGround: '#a9c98f', hemi: 1.0, sun: '#fff0d4', sunIntensity: 1.7, sunFrom: [-0.8, 0.75, 0.5] },
  midday: { background: '#a3daff', hemiSky: '#eef8ff', hemiGround: '#9fd182', hemi: 1.1, sun: '#ffffff', sunIntensity: 2.0, sunFrom: [0.3, 1, 0.45] },
  'late-afternoon': { background: '#ffdcae', hemiSky: '#ffe9c8', hemiGround: '#bba57c', hemi: 0.95, sun: '#ffc68a', sunIntensity: 1.8, sunFrom: [0.85, 0.55, 0.3] },
  dusk: { background: '#caa6d9', hemiSky: '#ead0f2', hemiGround: '#705d7c', hemi: 0.8, sun: '#ffa07c', sunIntensity: 1.2, sunFrom: [0.9, 0.3, -0.2] },
  night: { background: '#1e2654', hemiSky: '#6474b4', hemiGround: '#232a40', hemi: 0.55, sun: '#c3d4ff', sunIntensity: 0.55, sunFrom: [-0.4, 0.9, -0.3] },
}

export interface WorldView {
  /** The ground, props and places; add it to the scene. */
  root: THREE.Group
  /** The hemisphere light and the sun (with shadows); add them to the scene. */
  lights: THREE.Group
  /** The ground mesh, for picking a tile with a Raycaster. */
  ground: THREE.Mesh
  /** The sky's background and fog colour. */
  sky: THREE.Color
  /** Fog near and far for this world's size. */
  fog: { near: number; far: number }
  /** Shows or hides the places' outlines and names. */
  setLabels(visible: boolean): void
  /** Builds everything again from a changed world. */
  rebuild(world: WorldDoc): void
  dispose(): void
}

/** A small, stable variation per tile, so a field of grass isn't one flat colour. */
const jitter = (x: number, z: number): number => {
  const n = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return (n - Math.floor(n) - 0.5) * 0.06
}

function groundMesh(world: WorldDoc): THREE.Mesh {
  const [w, d] = world.size
  const colors = PALETTES[world.palette].ground
  const positions = new Float32Array(w * d * 18)
  const tint = new Float32Array(w * d * 18)
  const color = new THREE.Color()
  let i = 0
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const type = groundAt(world, x, z)
      const y = type === 'water' ? -0.07 : 0
      color.set(colors[type]).offsetHSL(0, 0, jitter(x, z))
      // Two triangles, wound so the face points up.
      for (const [px, pz] of [[x, z], [x, z + 1], [x + 1, z], [x + 1, z], [x, z + 1], [x + 1, z + 1]] as const) {
        positions.set([px, y, pz], i)
        tint.set([color.r, color.g, color.b], i)
        i += 3
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.BufferAttribute(tint, 3))
  g.computeVertexNormals()
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }))
  mesh.receiveShadow = true
  mesh.name = 'ground'
  return mesh
}

/** A place's name on a rounded card, as a sprite that always faces the camera. */
function label(text: string, accent: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.font = '600 52px system-ui, -apple-system, "Segoe UI", sans-serif'
  const width = Math.min(500, ctx.measureText(text).width + 64)
  const left = (512 - width) / 2
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.beginPath()
  ctx.roundRect(left, 20, width, 88, 44)
  ctx.fill()
  ctx.fillStyle = accent
  ctx.fillRect(left + 28, 58, 12, 12)
  ctx.fillStyle = '#2a2a3a'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, left + 52, 66, width - 72)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // The same size on screen however near the camera is, as map labels are: close up behind your companion
  // or from the editor's view over the whole world. (With sizeAttenuation off, scale is in view units at
  // distance 1: about 5% of the view's height for a 42° camera.)
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true, sizeAttenuation: false }))
  sprite.scale.set(0.15, 0.0375, 1)
  return sprite
}

export function createWorldView(first: WorldDoc, options: { labels?: boolean; shadows?: boolean } = {}): WorldView {
  const root = new THREE.Group()
  root.name = 'world'
  const lights = new THREE.Group()
  const hemi = new THREE.HemisphereLight()
  const sun = new THREE.DirectionalLight()
  lights.add(hemi, sun, sun.target)
  let labelsOn = options.labels !== false
  let markers: THREE.Object3D[] = []
  let owned: Array<{ dispose(): void }> = []
  // Made by rebuild(), below, like everything else that shows the world.
  let ground = new THREE.Mesh()

  const view: WorldView = {
    root,
    lights,
    ground,
    sky: new THREE.Color(),
    fog: { near: 0, far: 0 },
    setLabels(visible) {
      labelsOn = visible
      for (const m of markers) m.visible = visible
    },
    rebuild(world) {
      for (const o of owned) o.dispose()
      owned = []
      markers = []
      root.clear()
      const c = PALETTES[world.palette]
      const [w, d] = world.size
      ground = groundMesh(world)
      view.ground = ground
      owned.push(ground.geometry, ground.material as THREE.Material)
      root.add(ground)
      // The earth the world stands on, a little wider than the ground; its top is below the water, which sits lower than the land.
      const baseGeometry = new THREE.BoxGeometry(w + 0.3, 0.9, d + 0.3)
      const baseMaterial = new THREE.MeshStandardMaterial({ color: c.soil, roughness: 1 })
      owned.push(baseGeometry, baseMaterial)
      const base = new THREE.Mesh(baseGeometry, baseMaterial)
      base.position.set(w / 2, -0.56, d / 2)
      base.receiveShadow = true
      root.add(base)

      for (const p of world.props) {
        const object = prop(p.kit, { palette: world.palette, ...(p.tint ? { tint: p.tint } : {}) })
        object.position.set(p.at[0], p.at[1], p.at[2])
        object.rotation.y = -((p.turn ?? 0) * Math.PI) / 180
        root.add(object)
      }

      for (const place of world.places) {
        const [x0, z0, x1, z1] = place.area
        const points = [new THREE.Vector3(x0, 0.03, z0), new THREE.Vector3(x1 + 1, 0.03, z0), new THREE.Vector3(x1 + 1, 0.03, z1 + 1), new THREE.Vector3(x0, 0.03, z1 + 1)]
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(points)
        const lineMaterial = new THREE.LineDashedMaterial({ color: place.opens ? c.accent : '#ffffff', dashSize: 0.4, gapSize: 0.25, transparent: true, opacity: 0.9 })
        const outline = new THREE.LineLoop(lineGeometry, lineMaterial)
        outline.computeLineDistances()
        const tag = label(place.name, place.opens ? c.accent : '#8a8aa0')
        tag.position.set((x0 + x1 + 1) / 2, 2.9, (z0 + z1 + 1) / 2)
        const spriteMaterial = tag.material as THREE.SpriteMaterial
        owned.push(lineGeometry, lineMaterial, spriteMaterial.map as THREE.Texture, spriteMaterial)
        outline.visible = labelsOn
        tag.visible = labelsOn
        markers.push(outline, tag)
        root.add(outline, tag)
      }

      const sky = SKIES[world.sky]
      view.sky.set(sky.background)
      view.fog = { near: Math.max(w, d) * 0.9, far: Math.max(w, d) * 2.6 }
      hemi.color.set(sky.hemiSky)
      hemi.groundColor.set(sky.hemiGround)
      hemi.intensity = sky.hemi
      sun.color.set(sky.sun)
      sun.intensity = sky.sunIntensity
      const span = Math.max(w, d)
      const dir = new THREE.Vector3(...sky.sunFrom).normalize()
      sun.position.set(w / 2 + dir.x * span, dir.y * span, d / 2 + dir.z * span)
      sun.target.position.set(w / 2, 0, d / 2)
      if (options.shadows !== false) {
        sun.castShadow = true
        sun.shadow.mapSize.set(2048, 2048)
        const half = span * 0.75
        Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: span * 3 })
        sun.shadow.camera.updateProjectionMatrix()
        sun.shadow.bias = -0.0008
      }
    },
    dispose() {
      for (const o of owned) o.dispose()
      owned = []
      root.clear()
      sun.dispose()
      hemi.dispose()
    },
  }
  view.rebuild(first)
  return view
}
