/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier-kit/props.js (docs/apps.md › The kit, Worlds): the kit's props, made
// from simple rounded shapes in the companions' soft, bright style, so a world
// built from them looks like the companions' own. A prop stands on y = 0 at
// its own middle; one unit is a tile, about the height of a companion. Colours
// come from the world's palette; `tint.accent` recolours its accent parts.
import * as THREE from 'three'
import type { WorldGround, WorldPalette, WorldPropId } from '@shared/worlds'

export interface PaletteColors {
  ground: Record<WorldGround, string>
  soil: string
  wood: string
  leaf: string
  leafDark: string
  roof: string
  wall: string
  metal: string
  stone: string
  accent: string
  cloth: string
  water: string
  glow: string
}

/** Each palette's colours, ground first. */
export const PALETTES: Record<WorldPalette, PaletteColors> = {
  meadow: {
    ground: { grass: '#8fd16a', path: '#ead6a6', sand: '#f2dc9b', boards: '#c48f5e', stone: '#bfc3cb', floor: '#efe2cc', water: '#5ec4e8', snow: '#f4f7fb' },
    soil: '#8a6448', wood: '#9a6a43', leaf: '#62b85b', leafDark: '#3f914b', roof: '#e8705a', wall: '#fff4e2', metal: '#5c6472', stone: '#b4b8c2', accent: '#ff8a5c', cloth: '#ffd166', water: '#6fd0f0', glow: '#fff1b8',
  },
  seaside: {
    ground: { grass: '#9fd47e', path: '#f1e1b8', sand: '#f6e3a8', boards: '#b98257', stone: '#c9ccd2', floor: '#f3e9d6', water: '#3fb6e0', snow: '#f4f7fb' },
    soil: '#a07a58', wood: '#a7774f', leaf: '#6fc06a', leafDark: '#4a9a58', roof: '#3f8fd6', wall: '#fffaf0', metal: '#55606e', stone: '#c3c7ce', accent: '#ff6f61', cloth: '#ffffff', water: '#4fc3ea', glow: '#fff1b8',
  },
  city: {
    ground: { grass: '#86c46a', path: '#d6d0c4', sand: '#e8d8a8', boards: '#a87a55', stone: '#a9aeb8', floor: '#e2ddd4', water: '#5aaed6', snow: '#f4f7fb' },
    soil: '#6f6a66', wood: '#8a6446', leaf: '#5aa95a', leafDark: '#3c8048', roof: '#5b6b8a', wall: '#f0ebe4', metal: '#4b5260', stone: '#9ea3ad', accent: '#7c6cff', cloth: '#ffcf5c', water: '#62b6de', glow: '#ffe9a8',
  },
  snow: {
    ground: { grass: '#c9e3c0', path: '#e6ddd0', sand: '#efe3c4', boards: '#b58a63', stone: '#c6cbd4', floor: '#efe6da', water: '#7cc8e8', snow: '#f7faff' },
    soil: '#8d7a6c', wood: '#8c6448', leaf: '#4e9a6a', leafDark: '#2f7553', roof: '#d9534f', wall: '#fff8ee', metal: '#5c6472', stone: '#c0c5ce', accent: '#e94f6a', cloth: '#ffffff', water: '#8fd2ee', glow: '#fff1b8',
  },
  dusk: {
    ground: { grass: '#7fb86a', path: '#d9c39c', sand: '#e6cf98', boards: '#a9774f', stone: '#a7a4b4', floor: '#e3d3c2', water: '#5a9fd0', snow: '#eef0f8' },
    soil: '#6e5446', wood: '#865b3c', leaf: '#5aa05a', leafDark: '#3a7a48', roof: '#c25d7a', wall: '#fbe9d9', metal: '#4d4f63', stone: '#a29fb0', accent: '#ffb347', cloth: '#f7d6e0', water: '#6aa8d8', glow: '#ffd9a0',
  },
}

/** What each prop is called and how much ground it covers (in tiles, before turning), for the editor. */
export const PROPS: Record<WorldPropId, { name: string; footprint: [number, number] }> = {
  tree: { name: 'Tree', footprint: [1, 1] },
  pine: { name: 'Pine', footprint: [1, 1] },
  bush: { name: 'Bush', footprint: [1, 1] },
  flowers: { name: 'Flower bed', footprint: [1, 1] },
  rock: { name: 'Rock', footprint: [1, 1] },
  bench: { name: 'Bench', footprint: [2, 1] },
  table: { name: 'Table', footprint: [1, 1] },
  chair: { name: 'Chair', footprint: [1, 1] },
  lamp: { name: 'Lamp post', footprint: [1, 1] },
  fence: { name: 'Fence', footprint: [2, 1] },
  house: { name: 'House', footprint: [3, 3] },
  shop: { name: 'Shop', footprint: [3, 3] },
  stall: { name: 'Market stall', footprint: [2, 1] },
  counter: { name: 'Counter', footprint: [2, 1] },
  'table-tennis-table': { name: 'Table tennis table', footprint: [2, 1] },
  fountain: { name: 'Fountain', footprint: [2, 2] },
  sign: { name: 'Sign', footprint: [1, 1] },
  crate: { name: 'Crate', footprint: [1, 1] },
  barrel: { name: 'Barrel', footprint: [1, 1] },
  umbrella: { name: 'Parasol', footprint: [1, 1] },
}

// Geometries are shared by every prop; materials by colour.
const geometries = new Map<string, THREE.BufferGeometry>()
const geometry = (key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry => {
  let g = geometries.get(key)
  if (!g) {
    g = make()
    geometries.set(key, g)
  }
  return g
}
const materials = new Map<string, THREE.MeshStandardMaterial>()
const material = (color: string, glow = false): THREE.MeshStandardMaterial => {
  const key = `${color}${glow ? ':glow' : ''}`
  let m = materials.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...(glow ? { emissive: new THREE.Color(color), emissiveIntensity: 0.9 } : {}) })
    materials.set(key, m)
  }
  return m
}

const box = (w: number, h: number, d: number): THREE.BufferGeometry => geometry(`box:${w}:${h}:${d}`, () => new THREE.BoxGeometry(w, h, d))
const cyl = (top: number, bottom: number, h: number, seg = 12): THREE.BufferGeometry => geometry(`cyl:${top}:${bottom}:${h}:${seg}`, () => new THREE.CylinderGeometry(top, bottom, h, seg))
const ball = (r: number, detail = 1): THREE.BufferGeometry => geometry(`ball:${r}:${detail}`, () => new THREE.IcosahedronGeometry(r, detail))
const cone = (r: number, h: number, seg = 10): THREE.BufferGeometry => geometry(`cone:${r}:${h}:${seg}`, () => new THREE.ConeGeometry(r, h, seg))
const pill = (r: number, len: number): THREE.BufferGeometry => geometry(`pill:${r}:${len}`, () => new THREE.CapsuleGeometry(r, len, 4, 10))

function part(group: THREE.Group, g: THREE.BufferGeometry, color: string, x: number, y: number, z: number, options: { rx?: number; ry?: number; rz?: number; sx?: number; sy?: number; sz?: number; glow?: boolean } = {}): THREE.Mesh {
  const mesh = new THREE.Mesh(g, material(color, options.glow))
  mesh.position.set(x, y, z)
  mesh.rotation.set(options.rx ?? 0, options.ry ?? 0, options.rz ?? 0)
  mesh.scale.set(options.sx ?? 1, options.sy ?? 1, options.sz ?? 1)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
  return mesh
}

/** Builds one prop: a group standing on y = 0, facing +z. */
export function prop(id: WorldPropId, options: { palette?: WorldPalette; tint?: { accent?: string } } = {}): THREE.Group {
  const c = PALETTES[options.palette ?? 'meadow']
  const accent = options.tint?.accent ?? c.accent
  const g = new THREE.Group()
  g.name = id
  switch (id) {
    case 'tree':
      part(g, cyl(0.09, 0.13, 1.1), c.wood, 0, 0.55, 0)
      part(g, ball(0.62), c.leaf, 0, 1.45, 0)
      part(g, ball(0.42), c.leafDark, 0.32, 1.2, 0.2)
      part(g, ball(0.38), c.leaf, -0.28, 1.25, -0.22)
      break
    case 'pine':
      part(g, cyl(0.08, 0.11, 0.6), c.wood, 0, 0.3, 0)
      part(g, cone(0.62, 1.0), c.leafDark, 0, 0.95, 0)
      part(g, cone(0.48, 0.85), c.leafDark, 0, 1.45, 0)
      part(g, cone(0.32, 0.7), c.leaf, 0, 1.9, 0)
      break
    case 'bush':
      part(g, ball(0.34), c.leaf, 0, 0.28, 0, { sy: 0.85 })
      part(g, ball(0.26), c.leafDark, 0.22, 0.22, 0.08, { sy: 0.85 })
      part(g, ball(0.24), c.leaf, -0.2, 0.2, -0.1, { sy: 0.85 })
      break
    case 'flowers': {
      part(g, box(0.9, 0.16, 0.9), c.wood, 0, 0.08, 0)
      part(g, box(0.8, 0.06, 0.8), c.soil, 0, 0.17, 0)
      const blooms = [accent, c.cloth, c.roof, accent, c.cloth]
      for (const [i, color] of blooms.entries()) {
        const a = (i / blooms.length) * Math.PI * 2
        part(g, cyl(0.015, 0.015, 0.22, 5), c.leafDark, Math.cos(a) * 0.24, 0.3, Math.sin(a) * 0.24)
        part(g, ball(0.08, 0), color, Math.cos(a) * 0.24, 0.43, Math.sin(a) * 0.24)
      }
      break
    }
    case 'rock':
      part(g, ball(0.34, 0), c.stone, 0, 0.2, 0, { sx: 1.2, sy: 0.7, ry: 0.4 })
      part(g, ball(0.2, 0), c.stone, 0.28, 0.12, 0.12, { sy: 0.7 })
      break
    case 'bench':
      part(g, box(1.6, 0.08, 0.42), c.wood, 0, 0.3, 0)
      part(g, box(1.6, 0.3, 0.06), c.wood, 0, 0.52, -0.2, { rx: -0.12 })
      for (const x of [-0.68, 0.68]) part(g, box(0.08, 0.3, 0.38), c.metal, x, 0.15, 0)
      break
    case 'table':
      part(g, cyl(0.42, 0.42, 0.06, 18), c.wood, 0, 0.46, 0)
      part(g, cyl(0.05, 0.05, 0.44, 8), c.metal, 0, 0.22, 0)
      part(g, cyl(0.22, 0.24, 0.03, 14), c.metal, 0, 0.015, 0)
      break
    case 'chair':
      part(g, box(0.38, 0.06, 0.38), accent, 0, 0.27, 0)
      part(g, box(0.38, 0.34, 0.05), accent, 0, 0.47, -0.17)
      for (const [x, z] of [[-0.15, -0.15], [0.15, -0.15], [-0.15, 0.15], [0.15, 0.15]] as const) part(g, box(0.04, 0.26, 0.04), c.metal, x, 0.13, z)
      break
    case 'lamp':
      part(g, cyl(0.04, 0.06, 2.1, 8), c.metal, 0, 1.05, 0)
      part(g, cyl(0.16, 0.2, 0.06, 10), c.metal, 0, 0.03, 0)
      part(g, ball(0.17), c.glow, 0, 2.2, 0, { glow: true })
      part(g, cone(0.22, 0.14, 10), c.metal, 0, 2.38, 0)
      break
    case 'fence':
      for (const x of [-0.9, -0.3, 0.3, 0.9]) part(g, box(0.1, 0.6, 0.1), c.wall, x, 0.3, 0)
      for (const y of [0.22, 0.46]) part(g, box(1.9, 0.07, 0.05), c.wall, 0, y, 0)
      break
    case 'house':
    case 'shop': {
      part(g, box(2.6, 1.7, 2.6), c.wall, 0, 0.85, 0)
      // A four-sided cone turned 45° is a pyramid roof over the square walls.
      part(g, cone(2.15, 1.1, 4), id === 'shop' ? accent : c.roof, 0, 2.25, 0, { ry: Math.PI / 4 })
      part(g, box(0.62, 1.0, 0.08), c.wood, 0, 0.5, 1.31)
      part(g, ball(0.04, 0), c.metal, 0.2, 0.5, 1.37)
      for (const x of [-0.85, 0.85]) part(g, box(0.5, 0.5, 0.06), c.water, x, 1.15, 1.31)
      if (id === 'shop') {
        part(g, box(2.5, 0.08, 0.7), c.cloth, 0, 1.55, 1.6, { rx: 0.3 })
        part(g, box(1.6, 0.36, 0.06), accent, 0, 1.95, 1.33)
      }
      break
    }
    case 'stall':
      part(g, box(1.7, 0.7, 0.7), c.wood, 0, 0.35, 0)
      for (const x of [-0.8, 0.8]) part(g, box(0.07, 1.6, 0.07), c.wood, x, 0.8, -0.3)
      part(g, box(1.9, 0.07, 1.1), accent, 0, 1.62, 0.1, { rx: 0.18 })
      for (const [i, x] of [-0.5, 0, 0.5].entries()) part(g, ball(0.12, 0), [c.roof, c.cloth, c.leaf][i] as string, x, 0.8, 0.05)
      break
    case 'counter':
      part(g, box(1.8, 0.85, 0.6), c.wood, 0, 0.425, 0)
      part(g, box(1.9, 0.07, 0.7), c.wall, 0, 0.88, 0)
      part(g, cyl(0.07, 0.06, 0.16, 10), c.cloth, -0.5, 1.0, 0)
      part(g, cyl(0.07, 0.06, 0.16, 10), accent, -0.3, 1.0, 0.05)
      break
    case 'table-tennis-table':
      part(g, box(1.7, 0.05, 0.95), '#2e7d5b', 0, 0.45, 0)
      part(g, box(1.7, 0.012, 0.03), '#ffffff', 0, 0.478, 0)
      part(g, box(0.02, 0.012, 0.95), '#ffffff', 0, 0.478, 0)
      part(g, box(0.03, 0.12, 1.0), '#f4f4f4', 0, 0.53, 0)
      for (const [x, z] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]] as const) part(g, box(0.05, 0.43, 0.05), c.metal, x, 0.215, z)
      part(g, cyl(0.11, 0.11, 0.015, 14), accent, 0.45, 0.48, 0.25, { rz: 0.1 })
      break
    case 'fountain':
      part(g, cyl(0.95, 1.0, 0.36, 20), c.stone, 0, 0.18, 0)
      part(g, cyl(0.82, 0.82, 0.05, 20), c.water, 0, 0.33, 0)
      part(g, cyl(0.12, 0.16, 0.9, 10), c.stone, 0, 0.7, 0)
      part(g, cyl(0.38, 0.28, 0.12, 14), c.stone, 0, 1.12, 0)
      part(g, ball(0.13), c.water, 0, 1.28, 0)
      break
    case 'sign':
      part(g, box(0.08, 1.1, 0.08), c.wood, 0, 0.55, 0)
      part(g, box(0.8, 0.42, 0.06), accent, 0, 1.0, 0.05)
      break
    case 'crate':
      part(g, box(0.5, 0.5, 0.5), c.wood, 0, 0.25, 0)
      for (const y of [0.08, 0.42]) part(g, box(0.52, 0.06, 0.52), c.soil, 0, y, 0)
      break
    case 'barrel':
      part(g, cyl(0.22, 0.2, 0.56, 14), c.wood, 0, 0.28, 0)
      for (const y of [0.1, 0.46]) part(g, cyl(0.235, 0.235, 0.04, 14), c.metal, 0, y, 0)
      break
    case 'umbrella':
      part(g, cyl(0.03, 0.03, 1.8, 6), c.metal, 0, 0.9, 0)
      part(g, cone(0.95, 0.38, 12), accent, 0, 1.85, 0)
      part(g, cyl(0.2, 0.24, 0.08, 10), c.metal, 0, 0.04, 0)
      break
  }
  return g
}

/** Frees the shared geometries and materials (when an app is done with every prop). */
export function disposeProps(): void {
  for (const g of geometries.values()) g.dispose()
  for (const m of materials.values()) m.dispose()
  geometries.clear()
  materials.clear()
}
