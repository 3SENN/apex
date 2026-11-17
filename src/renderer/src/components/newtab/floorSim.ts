/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Lounge: Atelier's new-tab floor (DS-75, DS-76). A pure simulation of the
// companions standing on it: idle life (turns, strolls, wanders, naps),
// gatherings that swap topic bubbles, hops when clicked, and pick-up, throw
// and landing physics. No DOM, deterministic with a seeded rng, so it is
// unit-tested in node; Floor.tsx draws it.
//
// Floor space: x runs -1 (left) to 1 (right), d runs -1 (back) to 1 (front),
// inside the unit disc, which the screen maps onto a flat ellipse (drawn as
// a soft ground of glyphs, floorGround). z is the height above the floor in
// the same units.

import { seededRng, type Rng } from '@shared/companionLogic'
import { FLOOR_CORE } from '../../ui/logic/ambient'
import { SPRING, springAt, springDuration } from '../../ui/logic/motion'

export type ReactionGlyph = 'heart' | 'sparkle' | 'question' | 'alarm' | 'music' | 'sun' | 'bolt' | 'moon'

/** What a companion talks about in a gathering; the renderer turns it into a favicon, a face or a glyph. */
export type FloorTopic = { type: 'favicon'; index: number } | { type: 'companion'; id: string } | { type: 'you' } | { type: 'glyph'; glyph: ReactionGlyph }

export interface FloorBubble {
  topic: FloorTopic
  /** Sim time it was raised, so the renderer can replay the reveal. */
  at: number
  until: number
}

export type ActorMode = 'stand' | 'walk' | 'nap' | 'chat' | 'held' | 'air'

export interface FloorActor {
  id: string
  x: number
  d: number
  z: number
  vx: number
  vd: number
  vz: number
  facing: -1 | 1
  mode: ActorMode
  /** Sim time the current behaviour ends. */
  until: number
  target: { x: number; d: number } | null
  speed: number
  partner: string | null
  /** Landing squash, up to 1 on impact, settling back to 0 on the shared spring (a little stretch past rest). */
  squash: number
  /** DS-81: the sim time of the last impact and how hard it was; the spring settles the squash from there. */
  squashAt: number
  squashFrom: number
  /** Tumble angle while airborne, radians. */
  spin: number
  spinRate: number
  /** Someone or something it turned to look at, and until when. */
  glance: { x: number; d: number; until: number } | null
  bubble: FloorBubble | null
  /** When it popped in (staggered on reveal). */
  enteredAt: number
  stepClock: number
  /** When it last raised a bubble in a chat, so partners take turns. */
  spokeAt: number
}

export interface KeepOut {
  /** A box in floor space the companions stay out of (the ask field and the perch). */
  x0: number
  x1: number
  d0: number
  d1: number
}

export type FloorEvent = { type: 'ripple'; x: number; d: number; strength: number } | { type: 'land'; id: string }

export interface FloorTopics {
  /** How many recent favicons the renderer can show. */
  favicons: number
  /** Whether "you" (your initial) is a topic. */
  you: boolean
}

export interface FloorWorld {
  time: number
  actors: FloorActor[]
  rng: Rng
  reduced: boolean
  keepOut: KeepOut | null
  topics: FloorTopics
  /** Since the last drain: ripples to draw, landings to sound. */
  events: FloorEvent[]
}

export const FLOOR = {
  /** Companions keep inside this radius (their feet). */
  rim: 0.94,
  gravity: 5.5,
  hopSpeed: 1.15,
  walkSpeed: 0.16,
  strollSpeed: 0.11,
  stepSeconds: 0.42,
  popStagger: 0.12,
  /** Closer than this counts as together. */
  near: 0.26,
  maxThrow: 3,
} as const

const BUBBLE_SECONDS = 1.6
const TURN_PAUSE = 0.35

const between = (rng: Rng, a: number, b: number): number => a + (b - a) * rng()

function clampMag(v: number, max: number): number {
  return Math.max(-max, Math.min(max, v))
}

export function inKeepOut(x: number, d: number, keepOut: KeepOut | null, pad = 0): boolean {
  if (!keepOut) return false
  return x > keepOut.x0 - pad && x < keepOut.x1 + pad && d > keepOut.d0 - pad && d < keepOut.d1 + pad
}

/** A free spot: on the floor, outside the keep-out box. */
export function isFree(x: number, d: number, keepOut: KeepOut | null): boolean {
  return Math.hypot(x, d) <= FLOOR.rim && !inKeepOut(x, d, keepOut, 0.04)
}

/** The nearest free spot to (x, d): back inside the rim, then out of the keep-out box along its shortest side. */
export function nearestFree(x: number, d: number, keepOut: KeepOut | null): { x: number; d: number } {
  let px = x
  let pd = d
  const r = Math.hypot(px, pd)
  if (r > FLOOR.rim) {
    px = (px / r) * FLOOR.rim
    pd = (pd / r) * FLOOR.rim
  }
  if (keepOut && inKeepOut(px, pd, keepOut, 0.04)) {
    const pad = 0.06
    const options = [
      { x: keepOut.x0 - pad, d: pd },
      { x: keepOut.x1 + pad, d: pd },
      { x: px, d: keepOut.d0 - pad },
      { x: px, d: keepOut.d1 + pad },
    ].filter((o) => Math.hypot(o.x, o.d) <= FLOOR.rim)
    options.sort((a, b) => Math.hypot(a.x - px, a.d - pd) - Math.hypot(b.x - px, b.d - pd))
    const best = options[0]
    if (best) return best
  }
  return { x: px, d: pd }
}

function randomSpot(world: FloorWorld, around?: { x: number; d: number; radius: number }): { x: number; d: number } {
  for (let i = 0; i < 24; i++) {
    const angle = world.rng() * Math.PI * 2
    const spot = around
      ? { x: around.x + Math.cos(angle) * around.radius * Math.sqrt(world.rng()), d: around.d + Math.sin(angle) * around.radius * Math.sqrt(world.rng()) }
      : { x: Math.cos(angle) * FLOOR.rim * Math.sqrt(world.rng()), d: Math.sin(angle) * FLOOR.rim * Math.sqrt(world.rng()) }
    if (isFree(spot.x, spot.d, world.keepOut)) return spot
  }
  return nearestFree(around?.x ?? 0.8, around?.d ?? 0.6, world.keepOut)
}

/**
 * Starting places, spread around the floor in a ring from the front centre
 * outward, and kept out of the field. Deterministic for a count.
 */
export function floorSlots(count: number, keepOut: KeepOut | null): Array<{ x: number; d: number }> {
  const slots: Array<{ x: number; d: number }> = []
  const radius = 0.72
  for (let i = 0; i < count; i++) {
    // Alternate left and right of the front, widening as more arrive.
    const k = Math.floor((i + 1) / 2)
    const side = i % 2 === 0 ? 1 : -1
    const angle = Math.PI / 2 - side * (0.55 + k * 0.42)
    const ring = i < 6 ? radius : radius * 0.62
    slots.push(nearestFree(Math.cos(angle) * ring, Math.sin(angle) * ring * 0.9, keepOut))
  }
  return slots
}

function newActor(id: string, spot: { x: number; d: number }, time: number, enteredAt: number, rng: Rng): FloorActor {
  return {
    id,
    x: spot.x,
    d: spot.d,
    z: 0,
    vx: 0,
    vd: 0,
    vz: 0,
    facing: spot.x > 0 ? -1 : 1,
    mode: 'stand',
    until: time + between(rng, 1.5, 4),
    target: null,
    speed: 0,
    partner: null,
    squash: 0,
    squashAt: -Infinity,
    squashFrom: 0,
    spin: 0,
    spinRate: 0,
    glance: null,
    bubble: null,
    enteredAt,
    stepClock: 0,
    spokeAt: -Infinity,
  }
}

export interface FloorOptions {
  seed?: number
  reduced?: boolean
  keepOut?: KeepOut | null
  topics?: FloorTopics
}

export function createFloor(ids: readonly string[], options: FloorOptions = {}): FloorWorld {
  const rng = seededRng(options.seed ?? 7)
  const keepOut = options.keepOut ?? null
  const slots = floorSlots(ids.length, keepOut)
  const world: FloorWorld = { time: 0, actors: [], rng, reduced: options.reduced === true, keepOut, topics: options.topics ?? { favicons: 0, you: false }, events: [] }
  world.actors = ids.map((id, i) => newActor(id, slots[i] ?? randomSpot(world), 0, i * FLOOR.popStagger, rng))
  return world
}

/** Adds companions that arrived (popping in one after another) and drops those that left. */
export function syncActors(world: FloorWorld, ids: readonly string[]): FloorWorld {
  const wanted = new Set(ids)
  const kept = world.actors.filter((a) => wanted.has(a.id))
  const have = new Set(kept.map((a) => a.id))
  let stagger = 0
  for (const id of ids) {
    if (have.has(id)) continue
    kept.push(newActor(id, randomSpot(world), world.time, world.time + stagger, world.rng))
    stagger += FLOOR.popStagger
  }
  // Partners that left end their chat.
  for (const actor of kept) {
    if (actor.partner && !wanted.has(actor.partner)) endChat(actor, world)
  }
  world.actors = kept
  return world
}

/** Everyone pops in again one after another (the floor was just shown). */
export function restagger(world: FloorWorld): void {
  world.actors.forEach((actor, i) => {
    actor.enteredAt = world.time + i * FLOOR.popStagger
  })
}

export function setKeepOut(world: FloorWorld, keepOut: KeepOut | null): void {
  world.keepOut = keepOut
  for (const actor of world.actors) {
    if (actor.mode === 'held' || actor.mode === 'air') continue
    if (!isFree(actor.x, actor.d, keepOut)) {
      const spot = nearestFree(actor.x, actor.d, keepOut)
      actor.x = spot.x
      actor.d = spot.d
      actor.target = null
      if (actor.mode === 'walk') rest(actor, world)
    }
  }
}

function actorById(world: FloorWorld, id: string): FloorActor | undefined {
  return world.actors.find((a) => a.id === id)
}

function rest(actor: FloorActor, world: FloorWorld, seconds?: number): void {
  actor.mode = 'stand'
  actor.target = null
  actor.speed = 0
  actor.until = world.time + (seconds ?? between(world.rng, 1.2, 3.5))
}

function endChat(actor: FloorActor, world: FloorWorld): void {
  actor.partner = null
  // A chat ends, or a partner who was waiting stops waiting.
  if (actor.mode === 'chat' || actor.mode === 'stand') rest(actor, world)
}

function raise(actor: FloorActor, world: FloorWorld, topic: FloorTopic, seconds: number): void {
  actor.bubble = { topic, at: world.time, until: world.time + seconds }
}

function pickTopic(world: FloorWorld, speaker: FloorActor): FloorTopic {
  const { rng, topics } = world
  const others = world.actors.filter((a) => a.id !== speaker.id && a.id !== speaker.partner)
  const roll = rng()
  if (roll < 0.35 && topics.favicons > 0) return { type: 'favicon', index: Math.floor(rng() * topics.favicons) }
  if (roll < 0.6 && others.length > 0) return { type: 'companion', id: (others[Math.floor(rng() * others.length)] as FloorActor).id }
  if (roll < 0.75 && topics.you) return { type: 'you' }
  const glyphs: ReactionGlyph[] = ['heart', 'sparkle', 'music', 'sun', 'bolt']
  return { type: 'glyph', glyph: glyphs[Math.floor(rng() * glyphs.length)] as ReactionGlyph }
}

function walkTo(actor: FloorActor, world: FloorWorld, target: { x: number; d: number }, speed: number): void {
  actor.mode = 'walk'
  actor.target = target
  actor.speed = speed
  actor.until = world.time + 12
  if (Math.abs(target.x - actor.x) > 0.01) actor.facing = target.x > actor.x ? 1 : -1
}

/** Picks the next idle behaviour. Under Reduce Motion nobody walks: they turn, nap and chat with near neighbours only. */
function decide(actor: FloorActor, world: FloorWorld): void {
  const { rng } = world
  const free = world.actors.filter((a) => a.id !== actor.id && a.mode === 'stand' && !a.partner)
  const near = free.filter((a) => Math.hypot(a.x - actor.x, a.d - actor.d) < (world.reduced ? 0.55 : 1.2))
  const roll = rng()
  if (roll < 0.06) {
    actor.mode = 'nap'
    actor.until = world.time + between(rng, 8, 14)
    raise(actor, world, { type: 'glyph', glyph: 'moon' }, actor.until - world.time)
    return
  }
  if (roll < 0.24 && near.length > 0) {
    const other = near[Math.floor(rng() * near.length)] as FloorActor
    actor.partner = other.id
    other.partner = actor.id
    if (world.reduced || Math.hypot(other.x - actor.x, other.d - actor.d) < FLOOR.near) {
      startChat(actor, other, world)
    } else {
      // Meet beside the other one, on whichever side is free.
      const side = actor.x < other.x ? -1 : 1
      const spot = nearestFree(other.x + side * 0.2, other.d + 0.02, world.keepOut)
      walkTo(actor, world, spot, FLOOR.walkSpeed)
      other.mode = 'stand'
      other.until = world.time + 12
      other.facing = actor.x < other.x ? -1 : 1
    }
    return
  }
  if (world.reduced || roll < 0.62) {
    // Stand a while and turn now and then.
    if (rng() < 0.5) actor.facing = actor.facing === 1 ? -1 : 1
    rest(actor, world)
    return
  }
  if (roll < 0.86) walkTo(actor, world, randomSpot(world, { x: actor.x, d: actor.d, radius: 0.3 }), FLOOR.strollSpeed)
  else walkTo(actor, world, randomSpot(world), FLOOR.walkSpeed)
}

function startChat(a: FloorActor, b: FloorActor, world: FloorWorld): void {
  const seconds = between(world.rng, 3.5, 6)
  for (const [self, other] of [[a, b], [b, a]] as const) {
    self.mode = 'chat'
    self.partner = other.id
    self.target = null
    self.until = world.time + seconds
    self.facing = other.x >= self.x ? 1 : -1
  }
  raise(a, world, pickTopic(world, a), BUBBLE_SECONDS)
  a.spokeAt = world.time
}

function stepWalk(actor: FloorActor, world: FloorWorld, dt: number): void {
  const target = actor.target
  if (!target) return rest(actor, world)
  const dx = target.x - actor.x
  const dd = target.d - actor.d
  const dist = Math.hypot(dx, dd)
  if (dist < 0.015) {
    actor.x = target.x
    actor.d = target.d
    const partner = actor.partner ? actorById(world, actor.partner) : undefined
    if (partner && partner.partner === actor.id && Math.hypot(partner.x - actor.x, partner.d - actor.d) < FLOOR.near * 1.4) startChat(actor, partner, world)
    else {
      if (partner) endChat(partner, world)
      actor.partner = null
      rest(actor, world)
    }
    return
  }
  const step = Math.min(dist, actor.speed * dt)
  const nx = actor.x + (dx / dist) * step
  const nd = actor.d + (dd / dist) * step
  if (!isFree(nx, nd, world.keepOut) && isFree(actor.x, actor.d, world.keepOut)) {
    // Something is in the way: stop here and think again.
    if (actor.partner) {
      const partner = actorById(world, actor.partner)
      if (partner) endChat(partner, world)
      actor.partner = null
    }
    rest(actor, world, 0.6)
    return
  }
  actor.x = nx
  actor.d = nd
  actor.facing = dx >= 0 ? 1 : -1
  actor.stepClock += dt
  if (actor.stepClock >= FLOOR.stepSeconds) {
    actor.stepClock = 0
    world.events.push({ type: 'ripple', x: actor.x, d: actor.d, strength: 0.25 })
  }
}

function stepAir(actor: FloorActor, world: FloorWorld, dt: number): void {
  actor.vz -= FLOOR.gravity * dt
  actor.z += actor.vz * dt
  actor.x += actor.vx * dt
  actor.d += actor.vd * dt
  actor.spin += actor.spinRate * dt
  // The rim is a soft wall.
  const r = Math.hypot(actor.x, actor.d)
  if (r > FLOOR.rim) {
    const nx = actor.x / r
    const nd = actor.d / r
    const along = actor.vx * nx + actor.vd * nd
    if (along > 0) {
      actor.vx -= 1.5 * along * nx
      actor.vd -= 1.5 * along * nd
    }
    actor.x = nx * FLOOR.rim
    actor.d = nd * FLOOR.rim
  }
  if (actor.z > 0 || actor.vz > 0) return
  // Landing.
  actor.z = 0
  const impact = -actor.vz
  actor.squash = Math.min(1, impact * 0.45)
  actor.squashAt = world.time
  actor.squashFrom = actor.squash
  world.events.push({ type: 'ripple', x: actor.x, d: actor.d, strength: Math.min(1, 0.35 + impact * 0.2) })
  world.events.push({ type: 'land', id: actor.id })
  if (impact > 1.1) {
    actor.vz = impact * 0.32
    actor.vx *= 0.55
    actor.vd *= 0.55
    actor.spinRate *= 0.5
    return
  }
  actor.vz = 0
  actor.vx = 0
  actor.vd = 0
  actor.spinRate = 0
  // Upright again: the nearest whole turn.
  actor.spin = 0
  const spot = nearestFree(actor.x, actor.d, world.keepOut)
  actor.x = spot.x
  actor.d = spot.d
  rest(actor, world, between(world.rng, 1, 2))
}

/** DS-81: the one shared spring settles a landing (the floor's only spring). */
const SQUASH_SECONDS = springDuration(SPRING)

/** The squash `time` seconds into the sim: the impact's amount, released on the spring, rest after it settles. */
export function landingSquash(actor: Pick<FloorActor, 'squashAt' | 'squashFrom'>, time: number): number {
  const t = time - actor.squashAt
  if (!(t >= 0) || t >= SQUASH_SECONDS) return 0
  return actor.squashFrom * (1 - springAt(t, SPRING))
}

/** Advances the floor by `dt` seconds. */
export function stepFloor(world: FloorWorld, dt: number): FloorWorld {
  const step = Math.max(0, Math.min(0.1, dt))
  world.time += step
  const { time } = world
  for (const actor of world.actors) {
    actor.squash = landingSquash(actor, time)
    if (actor.bubble && time >= actor.bubble.until) actor.bubble = null
    if (actor.glance && time >= actor.glance.until) actor.glance = null
    if (time < actor.enteredAt) continue
    switch (actor.mode) {
      case 'held':
        break
      case 'air':
        stepAir(actor, world, step)
        break
      case 'walk':
        stepWalk(actor, world, step)
        if (time >= actor.until) rest(actor, world)
        break
      case 'chat': {
        const partner = actor.partner ? actorById(world, actor.partner) : undefined
        if (!partner || partner.mode !== 'chat') {
          endChat(actor, world)
          break
        }
        if (time >= actor.until) {
          endChat(actor, world)
          break
        }
        // Take turns: after a short pause, the one who spoke less recently speaks.
        const quiet = !actor.bubble && !partner.bubble && time - Math.max(actor.spokeAt, partner.spokeAt) > BUBBLE_SECONDS + TURN_PAUSE
        if (quiet && actor.spokeAt <= partner.spokeAt) {
          raise(actor, world, pickTopic(world, actor), BUBBLE_SECONDS)
          actor.spokeAt = time
        }
        break
      }
      case 'nap':
        if (time >= actor.until) {
          actor.bubble = null
          rest(actor, world)
        }
        break
      case 'stand':
        if (time >= actor.until && !actor.partner) decide(actor, world)
        else if (time >= actor.until && actor.partner) {
          // Waited for a partner who never came.
          const partner = actorById(world, actor.partner)
          if (partner) partner.partner = partner.partner === actor.id ? null : partner.partner
          actor.partner = null
          rest(actor, world)
        }
        break
    }
  }
  return world
}

/** Returns and clears the events since the last drain. */
export function drainEvents(world: FloorWorld): FloorEvent[] {
  const events = world.events
  world.events = []
  return events
}

// ---- interaction ----

/** Turns everyone (except `except`) towards a point for a moment. */
export function glanceAll(world: FloorWorld, at: { x: number; d: number }, seconds = 1.2, except?: string): void {
  for (const actor of world.actors) {
    if (actor.id === except || actor.mode === 'held' || actor.mode === 'air') continue
    actor.glance = { x: at.x, d: at.d, until: world.time + seconds }
    if (Math.abs(at.x - actor.x) > 0.02) actor.facing = at.x > actor.x ? 1 : -1
  }
}

/** A click: a reaction bubble and a hop (no hop under Reduce Motion); neighbours turn to look. */
export function pokeActor(world: FloorWorld, id: string): void {
  const actor = actorById(world, id)
  if (!actor || actor.mode === 'held' || actor.mode === 'air') return
  if (actor.partner) {
    const partner = actorById(world, actor.partner)
    if (partner) endChat(partner, world)
    actor.partner = null
  }
  raise(actor, world, { type: 'glyph', glyph: world.rng() < 0.5 ? 'heart' : 'sparkle' }, 1.4)
  if (!world.reduced) {
    actor.mode = 'air'
    actor.vz = FLOOR.hopSpeed
    actor.vx = 0
    actor.vd = 0
  } else {
    rest(actor, world)
  }
  for (const other of world.actors) {
    if (other.id === id || Math.hypot(other.x - actor.x, other.d - actor.d) > 0.7) continue
    if (other.mode === 'held' || other.mode === 'air') continue
    other.glance = { x: actor.x, d: actor.d, until: world.time + 1.2 }
    other.facing = actor.x > other.x ? 1 : -1
    if (world.rng() < 0.35 && !other.bubble) raise(other, world, { type: 'glyph', glyph: 'question' }, 1.2)
  }
}

/** Picked up: it dangles with an alarmed bubble and the others react. */
export function grabActor(world: FloorWorld, id: string): void {
  const actor = actorById(world, id)
  if (!actor) return
  if (actor.partner) {
    const partner = actorById(world, actor.partner)
    if (partner) endChat(partner, world)
    actor.partner = null
  }
  actor.mode = 'held'
  actor.vx = 0
  actor.vd = 0
  actor.vz = 0
  raise(actor, world, { type: 'glyph', glyph: 'alarm' }, 60)
  for (const other of world.actors) {
    if (other.id === id || other.mode === 'air') continue
    other.glance = { x: actor.x, d: actor.d, until: world.time + 1.6 }
    if (world.rng() < 0.4 && !other.bubble) raise(other, world, { type: 'glyph', glyph: world.rng() < 0.5 ? 'question' : 'alarm' }, 1.2)
  }
}

/** Moves a held companion; `lift` is its height in floor units. It leans into the drag. */
export function dragActor(world: FloorWorld, id: string, x: number, d: number, lift = 0.14): void {
  const actor = actorById(world, id)
  if (!actor || actor.mode !== 'held') return
  const dx = x - actor.x
  actor.spin = clampMag(actor.spin * 0.7 + dx * 2.2, 0.6)
  if (Math.abs(dx) > 0.002) actor.facing = dx > 0 ? 1 : -1
  actor.x = x
  actor.d = Math.max(-1, Math.min(1, d))
  actor.z = lift
}

/** Lets go with a velocity (floor units per second): it flies, tumbles, lands and squashes. */
export function throwActor(world: FloorWorld, id: string, vx: number, vd: number): void {
  const actor = actorById(world, id)
  if (!actor) return
  actor.bubble = null
  if (world.reduced) {
    const spot = nearestFree(actor.x, actor.d, world.keepOut)
    actor.x = spot.x
    actor.d = spot.d
    actor.z = 0
    actor.spin = 0
    rest(actor, world)
    return
  }
  actor.mode = 'air'
  actor.vx = clampMag(vx, FLOOR.maxThrow)
  actor.vd = clampMag(vd, FLOOR.maxThrow)
  const speed = Math.hypot(actor.vx, actor.vd)
  actor.vz = 0.4 + speed * 0.35
  actor.spinRate = speed > 1 ? clampMag(actor.vx * 5, 14) : 0
  if (actor.spinRate === 0) actor.spin = 0
}

/**
 * The companion that was on the ask field comes back to the floor: it lands
 * near `from`, knocked in `direction` (-1 left, 1 right). Under Reduce
 * Motion it simply appears at a free spot there.
 */
export function bumpToFloor(world: FloorWorld, id: string, from: { x: number; d: number }, direction: -1 | 1): void {
  let actor = actorById(world, id)
  if (!actor) {
    actor = newActor(id, nearestFree(from.x, from.d, null), world.time, world.time, world.rng)
    world.actors.push(actor)
  }
  actor.partner = null
  actor.bubble = null
  actor.x = from.x
  actor.d = from.d
  if (world.reduced) {
    const spot = nearestFree(from.x + direction * 0.35, from.d + 0.2, world.keepOut)
    actor.x = spot.x
    actor.d = spot.d
    actor.z = 0
    rest(actor, world)
    return
  }
  actor.mode = 'air'
  actor.z = 0.25
  actor.vx = direction * 0.95
  actor.vd = 0.55
  actor.vz = 1.1
  actor.spinRate = direction * 7
  actor.facing = direction
}

/** Takes a companion off the floor (it flies to the ask field). */
export function removeActor(world: FloorWorld, id: string): FloorActor | null {
  const actor = actorById(world, id)
  if (!actor) return null
  world.actors = world.actors.filter((a) => a.id !== id)
  for (const other of world.actors) if (other.partner === id) endChat(other, world)
  return actor
}

// ---- screen mapping ----

export interface FloorLayout {
  /** Centre of the floor ellipse and its radii, in CSS pixels. */
  cx: number
  cy: number
  rx: number
  ry: number
}

/**
 * The pond under the ask field (DS-75): as wide as the stage allows, flat,
 * and centred a little below the field's own card, so the card sits on the
 * pond's back half. `field` is the ask card alone (not the tray or ideas
 * under it), in stage pixels; without one the pond sits low on the stage.
 */
export function pondLayout(box: { width: number; height: number }, field: ScreenRect | null): FloorLayout {
  const rx = Math.min(box.width * 0.48, 540)
  const ry = rx * 0.27
  const cy = field ? (field.top + field.bottom) / 2 + ry * 0.28 : box.height * 0.62
  return { cx: box.width / 2, cy, rx, ry }
}

export interface FloorGround {
  /** The ground's box in stage pixels; its glyphs fade out toward the ellipse it inscribes. */
  left: number
  top: number
  width: number
  height: number
  /** Where its swells roll out from (the figure's feet), as fractions of the box. */
  origin: { x: number; y: number }
}

/**
 * How the ground of glyphs sits on the pond: wider than the pond so
 * companions at the rim still stand on it (but fading out by the stage's
 * sides, `sides` of its half-width), at least `roundness` as tall as it is
 * wide (a field of swells, not a flat disc), and tall enough that the
 * figure's feet are inside its full-strength `core`, but never taller than wide.
 */
export const GROUND = { spread: 1.3, sides: 1.04, roundness: 0.46, core: FLOOR_CORE } as const

/**
 * The ground under the Lounge, centred on the pond. Its swells roll out from
 * the feet of the figure above the ask field (`feet`, stage pixels); without
 * one, from the pond's back rim, where the figure would stand.
 */
export function floorGround(layout: FloorLayout, feet: { x: number; y: number } | null): FloorGround {
  // The pond is centred on the stage, so cx is half its width.
  const halfW = Math.max(1, Math.min(layout.rx * GROUND.spread, layout.cx * GROUND.sides))
  const at = feet ?? { x: layout.cx, y: layout.cy - layout.ry * 0.72 }
  const halfH = Math.min(halfW, Math.max(halfW * GROUND.roundness, Math.abs(layout.cy - at.y) / GROUND.core))
  const left = layout.cx - halfW
  const top = layout.cy - halfH
  return { left, top, width: halfW * 2, height: halfH * 2, origin: groundPoint({ left, top, width: halfW * 2, height: halfH * 2 }, at.x, at.y) }
}

/** A stage point as fractions of the ground's box (for a ripple), held to the box. */
export function groundPoint(ground: Pick<FloorGround, 'left' | 'top' | 'width' | 'height'>, x: number, y: number): { x: number; y: number } {
  const fx = (x - ground.left) / Math.max(1, ground.width)
  const fy = (y - ground.top) / Math.max(1, ground.height)
  return { x: Math.min(1, Math.max(0, fx)), y: Math.min(1, Math.max(0, fy)) }
}

/** Where an actor's feet are on screen, how big it is (smaller towards the back) and its stacking order. */
export function screenOf(actor: Pick<FloorActor, 'x' | 'd' | 'z'>, layout: FloorLayout): { left: number; top: number; scale: number; order: number } {
  const scale = 0.8 + 0.2 * ((actor.d + 1) / 2)
  return {
    left: layout.cx + actor.x * layout.rx,
    top: layout.cy + actor.d * layout.ry - actor.z * layout.rx * 0.9,
    scale,
    order: Math.round((actor.d + 1) * 500),
  }
}

/** The floor point under a screen point (z = 0). */
export function floorOf(px: number, py: number, layout: FloorLayout): { x: number; d: number } {
  return { x: (px - layout.cx) / Math.max(1, layout.rx), d: (py - layout.cy) / Math.max(1, layout.ry) }
}

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The screen area companions keep their feet out of, in stage pixels: the
 * ask field (and anything above it), widened a little at the sides, and
 * reaching below the field by a whole standing figure. Figures are drawn
 * upward from their feet, so feet just under the field would still put the
 * head and body behind it.
 */
export function keepOutRect(fields: readonly ScreenRect[], actorHeight: number, sidePad = 26, margin = 6): ScreenRect | null {
  if (fields.length === 0) return null
  return {
    left: Math.min(...fields.map((r) => r.left)) - sidePad,
    right: Math.max(...fields.map((r) => r.right)) + sidePad,
    top: Math.min(...fields.map((r) => r.top)),
    bottom: Math.max(...fields.map((r) => r.bottom)) + actorHeight + margin,
  }
}

/** A screen rectangle as a keep-out box in floor space. */
export function keepOutOf(rect: { left: number; top: number; right: number; bottom: number }, layout: FloorLayout): KeepOut {
  const a = floorOf(rect.left, rect.top, layout)
  const b = floorOf(rect.right, rect.bottom, layout)
  return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), d0: Math.min(a.d, b.d), d1: Math.max(a.d, b.d) }
}
