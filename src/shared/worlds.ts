/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Worlds (docs/apps.md › Worlds): a place made of ground, kit props, named
// places, residents and a sky. You walk around it as your companion; stepping
// into a place opens its app with the residents there as its cast. A world is
// a JSON file inside a pack (contributes.worlds), or one of your own that Apex
// keeps for you; it shares as a pack that holds just the world (.apexworld).
import type { CompanionLook } from './companion'

export const WORLD_FORMAT = 'apex-world'
/** The first-party pack whose app shows and edits worlds. */
export const WORLDS_PACK_ID = 'apex-worlds'
export const WORLD_VERSION = 1
/** The file a pack that is only a world travels as. */
export const WORLD_FILE_EXTENSION = 'apexworld'

/** Starting values (docs/apps.md › Worlds › Limits). */
export const WORLD_LIMITS = {
  fileBytes: 2 * 1024 * 1024,
  minSize: 8,
  maxSize: 128,
  props: 5_000,
  paints: 2_000,
  places: 64,
  residents: 32,
  /** Worlds one pack may hold. */
  perPack: 10,
  /** The person's own worlds. */
  own: 100,
} as const

export const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

export const WORLD_PALETTES = ['meadow', 'seaside', 'city', 'snow', 'dusk'] as const
export type WorldPalette = (typeof WORLD_PALETTES)[number]

export const WORLD_SKIES = ['morning', 'midday', 'late-afternoon', 'dusk', 'night'] as const
export type WorldSky = (typeof WORLD_SKIES)[number]

export const WORLD_GROUNDS = ['grass', 'path', 'sand', 'boards', 'stone', 'floor', 'water', 'snow'] as const
export type WorldGround = (typeof WORLD_GROUNDS)[number]

/** The kit's props (apex-kit/props.js), by id, with the name the editor shows. */
export const WORLD_PROPS = {
  tree: 'Tree',
  pine: 'Pine',
  bush: 'Bush',
  flowers: 'Flower bed',
  rock: 'Rock',
  bench: 'Bench',
  table: 'Table',
  chair: 'Chair',
  lamp: 'Lamp post',
  fence: 'Fence',
  house: 'House',
  shop: 'Shop',
  stall: 'Market stall',
  counter: 'Counter',
  'table-tennis-table': 'Table tennis table',
  fountain: 'Fountain',
  sign: 'Sign',
  crate: 'Crate',
  barrel: 'Barrel',
  umbrella: 'Parasol',
} as const
export type WorldPropId = keyof typeof WORLD_PROPS
export const WORLD_PROP_IDS = Object.keys(WORLD_PROPS) as WorldPropId[]

/** A rectangle of tiles: [x0, z0, x1, z1], corners included, x0 ≤ x1 and z0 ≤ z1. */
export type WorldArea = [number, number, number, number]

export interface WorldProp {
  kit: WorldPropId
  /** Where it stands: [x, y, z] in tiles (y is usually 0). */
  at: [number, number, number]
  /** Degrees around the vertical. */
  turn?: number
  tint?: { accent?: string }
}

export interface WorldPlace {
  id: string
  name: string
  area: WorldArea
  /** The app stepping in opens; the residents there are its cast. */
  opens?: { pack: string; app: string }
}

export interface WorldResident {
  id: string
  /** The place they spend their day in. */
  home?: string
  /** Where they stand, in tiles; else the middle of their home. */
  at?: [number, number]
  /** What they do there, in a few words ("Runs the café"); also what they talk about. */
  role?: string
  /** A guest: carried in the file (a name, a look, a personality), never memory or instructions. */
  guest?: { name: string; look: CompanionLook; personality?: string }
  /** An open spot the person who adds the world fills with one of their own companions. */
  companion?: 'local'
}

export interface WorldDoc {
  format: typeof WORLD_FORMAT
  version: number
  id: string
  name: string
  description?: string
  palette: WorldPalette
  sky: WorldSky
  /** Width and depth in tiles. */
  size: [number, number]
  ground: { base: WorldGround; paint: Array<{ type: WorldGround; area: WorldArea }> }
  props: WorldProp[]
  places: WorldPlace[]
  residents: WorldResident[]
  /** Where you start, in tiles; else the middle. */
  spawn?: [number, number]
  /** Where the camera starts and what it looks at, for the still and the first frame. */
  camera?: { at: [number, number, number]; lookAt: [number, number, number] }
}

/** A world as Apex lists it: one of yours (`own:<id>`) or one a pack brought (`pack:<packId>/<path>`). */
export interface WorldEntry {
  ref: string
  id: string
  name: string
  description: string
  /** 'own', or the pack's name. */
  from: string
  /** Only your own worlds change in place; a pack's world is copied into yours to change. */
  editable: boolean
  places: number
  residents: number
  updatedAt: number
}

/** What an app opened from a world's place reads (apex.world.context()). */
export interface WorldContext {
  world: { ref: string; name: string; palette: WorldPalette; sky: WorldSky }
  place: { id: string; name: string }
  /** You (the companion you walked in as) and the residents there, as cast members of this app: guests and the person's own companions alike. */
  cast: Array<{ ref: string; name: string; look: CompanionLook; guest: boolean; role: string | null }>
}

export const ownWorldRef = (id: string): string => `own:${id}`
export const packWorldRef = (packId: string, path: string): string => `pack:${packId}/${path}`

/** A world ref's parts, or null for anything else. */
export function parseWorldRef(ref: string): { kind: 'own'; id: string } | { kind: 'pack'; packId: string; path: string } | null {
  const own = /^own:([a-z0-9][a-z0-9-]{0,47})$/.exec(ref)
  if (own) return { kind: 'own', id: own[1] as string }
  const pack = /^pack:([a-z0-9][a-z0-9-]{1,31})\/(.{1,300})$/.exec(ref)
  if (pack) return { kind: 'pack', packId: pack[1] as string, path: pack[2] as string }
  return null
}

/** Whether a tile is inside an area. */
export const inArea = (area: WorldArea, x: number, z: number): boolean => x >= area[0] && x <= area[2] && z >= area[1] && z <= area[3]

/** The place a tile is in, the last one listed winning where places overlap; null outside every place. */
export function placeAt(world: Pick<WorldDoc, 'places'>, x: number, z: number): WorldPlace | null {
  for (let i = world.places.length - 1; i >= 0; i--) {
    const place = world.places[i] as WorldPlace
    if (inArea(place.area, Math.floor(x), Math.floor(z))) return place
  }
  return null
}

/** The ground of a tile: the last paint that covers it, else the base. */
export function groundAt(world: Pick<WorldDoc, 'ground'>, x: number, z: number): WorldGround {
  const paint = world.ground.paint
  for (let i = paint.length - 1; i >= 0; i--) {
    const p = paint[i] as { type: WorldGround; area: WorldArea }
    if (inArea(p.area, x, z)) return p.type
  }
  return world.ground.base
}

/** Where a resident stands: their own spot, else the middle of their home, else the world's middle. */
export function residentSpot(world: Pick<WorldDoc, 'places' | 'size'>, resident: Pick<WorldResident, 'at' | 'home'>): [number, number] {
  if (resident.at) return resident.at
  const home = resident.home ? world.places.find((p) => p.id === resident.home) : undefined
  if (home) return [(home.area[0] + home.area[2] + 1) / 2, (home.area[1] + home.area[3] + 1) / 2]
  return [world.size[0] / 2, world.size[1] / 2]
}

/** An empty world to start from. */
export function blankWorld(id: string, name: string): WorldDoc {
  return {
    format: WORLD_FORMAT,
    version: WORLD_VERSION,
    id,
    name,
    palette: 'meadow',
    sky: 'midday',
    size: [32, 24],
    ground: { base: 'grass', paint: [] },
    props: [],
    places: [],
    residents: [],
    spawn: [16, 12],
  }
}
