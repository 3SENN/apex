/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  bumpToFloor,
  createFloor,
  drainEvents,
  dragActor,
  FLOOR,
  floorGround,
  floorOf,
  floorSlots,
  grabActor,
  GROUND,
  groundPoint,
  inKeepOut,
  isFree,
  keepOutOf,
  keepOutRect,
  nearestFree,
  pokeActor,
  pondLayout,
  removeActor,
  screenOf,
  stepFloor,
  syncActors,
  throwActor,
  type FloorWorld,
  type KeepOut,
} from '../src/renderer/src/components/newtab/floorSim'
import { readFileSync } from 'node:fs'
import { CLEARING, clearingMask, ellipseMask, fieldMask, FLOOR_CORE } from '../src/renderer/src/ui/logic/ambient'
import { contrastRatio } from '../src/shared/accent'
import type { CompanionPreset } from '../src/shared/companion'
import { flightDuration, flightPath, nameColor, parseFloorSetting, RAISED } from '../src/renderer/src/components/newtab/newtabLogic'
import { noteAskOrigin, takeAskOrigin } from '../src/renderer/src/components/newtab/handoff'
import { welcomeIntro, welcomePlacement } from '../src/renderer/src/pages/welcomeLogic'

const FIELD: KeepOut = { x0: -0.5, x1: 0.5, d0: -1, d1: 0.3 }
const IDS = ['pip', 'juniper', 'bolt', 'mochi', 'sage']

function simulate(world: FloorWorld, seconds: number, dt = 1 / 30): FloorWorld {
  for (let t = 0; t < seconds; t += dt) stepFloor(world, dt)
  return world
}

describe('the Lounge: placement', () => {
  it('starts everyone on the floor, out of the field, popping in one after another', () => {
    const world = createFloor(IDS, { keepOut: FIELD })
    for (const actor of world.actors) {
      expect(isFree(actor.x, actor.d, FIELD)).toBe(true)
    }
    const entries = world.actors.map((a) => a.enteredAt)
    expect(entries).toEqual([...entries].sort((a, b) => a - b))
    expect(new Set(entries).size).toBe(IDS.length)
  })

  it('slots are deterministic', () => {
    expect(floorSlots(4, FIELD)).toEqual(floorSlots(4, FIELD))
  })

  it('finds the nearest free spot out of the field and inside the rim', () => {
    const spot = nearestFree(0.1, 0, FIELD)
    expect(isFree(spot.x, spot.d, FIELD)).toBe(true)
    const outside = nearestFree(2, 2, null)
    expect(Math.hypot(outside.x, outside.d)).toBeLessThanOrEqual(FLOOR.rim + 1e-9)
  })

  it('adds arrivals and drops leavers', () => {
    const world = createFloor(['pip', 'bolt'], { keepOut: FIELD })
    world.time = 10
    syncActors(world, ['bolt', 'sage'])
    expect(world.actors.map((a) => a.id)).toEqual(['bolt', 'sage'])
    expect(world.actors[1]?.enteredAt).toBeGreaterThanOrEqual(10)
  })
})

describe('the Lounge: idle life', () => {
  it('is deterministic for a seed', () => {
    const a = simulate(createFloor(IDS, { seed: 3, keepOut: FIELD }), 30)
    const b = simulate(createFloor(IDS, { seed: 3, keepOut: FIELD }), 30)
    expect(a.actors.map((x) => [x.x, x.d, x.mode])).toEqual(b.actors.map((x) => [x.x, x.d, x.mode]))
  })

  it('wanders without ever standing in the field or leaving the floor', () => {
    const world = createFloor(IDS, { seed: 5, keepOut: FIELD })
    let moved = false
    const start = world.actors.map((a) => [a.x, a.d])
    for (let i = 0; i < 30 * 90; i++) {
      stepFloor(world, 1 / 30)
      for (const actor of world.actors) {
        if (actor.mode === 'air' || actor.mode === 'held') continue
        expect(Math.hypot(actor.x, actor.d)).toBeLessThanOrEqual(FLOOR.rim + 1e-6)
        expect(inKeepOut(actor.x, actor.d, FIELD)).toBe(false)
      }
    }
    world.actors.forEach((a, i) => {
      if (Math.hypot(a.x - (start[i]?.[0] ?? 0), a.d - (start[i]?.[1] ?? 0)) > 0.05) moved = true
    })
    expect(moved).toBe(true)
  })

  it('gathers in pairs that swap topic bubbles, and leaves footstep ripples', () => {
    const world = createFloor(IDS, { seed: 9, keepOut: FIELD, topics: { favicons: 3, you: true } })
    let chats = 0
    let topics = 0
    let ripples = 0
    for (let i = 0; i < 30 * 120; i++) {
      stepFloor(world, 1 / 30)
      if (world.actors.some((a) => a.mode === 'chat')) chats++
      if (world.actors.some((a) => a.bubble && a.bubble.topic.type !== 'glyph')) topics++
      ripples += drainEvents(world).filter((e) => e.type === 'ripple').length
    }
    expect(chats).toBeGreaterThan(0)
    expect(topics).toBeGreaterThan(0)
    expect(ripples).toBeGreaterThan(0)
  })

  it('under Reduce Motion nobody walks or hops', () => {
    const world = createFloor(IDS, { seed: 9, keepOut: FIELD, reduced: true })
    const start = world.actors.map((a) => [a.x, a.d])
    simulate(world, 120)
    world.actors.forEach((a, i) => {
      expect(a.x).toBeCloseTo(start[i]?.[0] ?? 0)
      expect(a.d).toBeCloseTo(start[i]?.[1] ?? 0)
      expect(a.mode).not.toBe('walk')
    })
    pokeActor(world, 'pip')
    expect(world.actors.find((a) => a.id === 'pip')?.mode).not.toBe('air')
    expect(world.actors.find((a) => a.id === 'pip')?.bubble).not.toBeNull()
  })
})

describe('the Lounge: interaction', () => {
  it('a click hops with a bubble, neighbours turn, and it lands with a ripple', () => {
    const world = createFloor(IDS, { seed: 2, keepOut: FIELD })
    world.time = 5
    pokeActor(world, 'pip')
    const pip = world.actors.find((a) => a.id === 'pip')
    expect(pip?.mode).toBe('air')
    expect(pip?.bubble?.topic).toMatchObject({ type: 'glyph' })
    simulate(world, 2)
    const events = drainEvents(world)
    expect(events.some((e) => e.type === 'land' && e.id === 'pip')).toBe(true)
    expect(world.actors.find((a) => a.id === 'pip')?.z).toBe(0)
  })

  it('picked up, dragged and thrown: it tumbles, lands, squashes and comes to rest on the floor', () => {
    const world = createFloor(IDS, { seed: 4, keepOut: FIELD })
    grabActor(world, 'bolt')
    expect(world.actors.find((a) => a.id === 'bolt')?.bubble?.topic).toEqual({ type: 'glyph', glyph: 'alarm' })
    dragActor(world, 'bolt', 0.7, 0.5)
    throwActor(world, 'bolt', 2.5, -0.4)
    let squashed = false
    for (let i = 0; i < 90; i++) {
      stepFloor(world, 1 / 30)
      if ((world.actors.find((a) => a.id === 'bolt')?.squash ?? 0) > 0.2) squashed = true
    }
    const bolt = world.actors.find((a) => a.id === 'bolt')
    expect(squashed).toBe(true)
    expect(bolt?.mode).not.toBe('air')
    expect(bolt?.spin).toBe(0)
    expect(isFree(bolt?.x ?? 0, bolt?.d ?? 0, FIELD)).toBe(true)
  })

  it('the companion knocked off the field lands back on the floor', () => {
    const world = createFloor(['juniper'], { seed: 1, keepOut: FIELD })
    bumpToFloor(world, 'pip', { x: 0, d: 0.35 }, 1)
    expect(world.actors.map((a) => a.id)).toContain('pip')
    simulate(world, 3)
    const pip = world.actors.find((a) => a.id === 'pip')
    expect(pip?.mode).not.toBe('air')
    expect(pip?.x).toBeGreaterThan(0)
    expect(isFree(pip?.x ?? 0, pip?.d ?? 0, FIELD)).toBe(true)
  })

  it('a companion taken to the field leaves the floor and ends its chat', () => {
    const world = createFloor(['pip', 'bolt'], { seed: 1 })
    const [a, b] = world.actors
    if (!a || !b) throw new Error('two actors')
    a.partner = b.id
    b.partner = a.id
    a.mode = 'chat'
    b.mode = 'chat'
    removeActor(world, 'pip')
    expect(world.actors.map((x) => x.id)).toEqual(['bolt'])
    expect(world.actors[0]?.partner).toBeNull()
  })
})

describe('the Lounge: screen mapping', () => {
  const layout = { cx: 500, cy: 300, rx: 400, ry: 110 }
  it('maps floor to screen and back, smaller towards the back', () => {
    const front = screenOf({ x: 0.5, d: 0.8, z: 0 }, layout)
    const back = screenOf({ x: 0.5, d: -0.8, z: 0 }, layout)
    expect(front.scale).toBeGreaterThan(back.scale)
    expect(front.order).toBeGreaterThan(back.order)
    const point = floorOf(front.left, front.top, layout)
    expect(point.x).toBeCloseTo(0.5)
    expect(point.d).toBeCloseTo(0.8)
  })

  it('lifts airborne companions', () => {
    expect(screenOf({ x: 0, d: 0, z: 0.2 }, layout).top).toBeLessThan(screenOf({ x: 0, d: 0, z: 0 }, layout).top)
  })

  it('keeps every free spot from putting a figure’s head behind the ask field', () => {
    const composer = { left: 300, top: 250, right: 700, bottom: 330 }
    const actor = 96 * 0.94
    const rect = keepOutRect([composer], actor)
    expect(rect?.bottom).toBeGreaterThanOrEqual(composer.bottom + actor)
    const keepOut = keepOutOf(rect!, layout)
    const spots = [...floorSlots(8, keepOut)]
    for (let x = -1; x <= 1; x += 0.05) for (let d = -1; d <= 1; d += 0.05) if (isFree(x, d, keepOut)) spots.push({ x, d })
    expect(spots.length).toBeGreaterThan(20)
    for (const spot of spots) {
      const s = screenOf({ ...spot, z: 0 }, layout)
      const head = s.top - actor * s.scale
      const overlapsX = s.left > composer.left - 20 && s.left < composer.right + 20
      // Feet behind the field are fine (the body stands above it); otherwise the body must clear it.
      const hidden = overlapsX && s.top > composer.top && head < composer.bottom
      expect(hidden, JSON.stringify(spot)).toBe(false)
    }
  })

  it('turns a screen rectangle into a keep-out box', () => {
    const box = keepOutOf({ left: 300, top: 250, right: 700, bottom: 330 }, layout)
    expect(box.x0).toBeCloseTo(-0.5)
    expect(box.x1).toBeCloseTo(0.5)
    expect(box.d0).toBeCloseTo(-50 / 110)
    expect(box.d1).toBeCloseTo(30 / 110)
  })
})

describe('new tab helpers', () => {
  it('the floor is on unless it was turned off', () => {
    expect(parseFloorSetting(null)).toBe(true)
    expect(parseFloorSetting(undefined)).toBe(true)
    expect(parseFloorSetting('on')).toBe(true)
    expect(parseFloorSetting('garbage')).toBe(true)
    expect(parseFloorSetting('off')).toBe(false)
  })

  it('flights scale with distance within 450–750 ms', () => {
    expect(flightDuration(0)).toBe(450)
    expect(flightDuration(10_000)).toBe(750)
    expect(flightDuration(300)).toBeGreaterThan(450)
  })

  it('a flight starts over the floor companion and lands feet-first on the perch', () => {
    const stage = { left: 100, top: 50, width: 1000, height: 600 }
    const from = { left: 200, top: 400, width: 96, height: 96 }
    const to = { left: 520, top: 150, width: 156, height: 156 }
    const { keyframes, duration } = flightPath(from, to, stage)
    expect(keyframes[0]?.offset).toBe(0)
    expect(keyframes[keyframes.length - 1]?.offset).toBe(1)
    expect(String(keyframes[keyframes.length - 1]?.transform)).toBe('translate(420.00px, 100.00px) scale(1.0000)')
    const first = String(keyframes[0]?.transform)
    expect(first).toContain(`scale(${(96 / 156).toFixed(4)})`)
    expect(duration).toBeGreaterThanOrEqual(450)
    // It rises above both ends on the way.
    const ys = keyframes.map((k) => Number(/translate\([^,]+, ([-\d.]+)px\)/.exec(String(k.transform))?.[1]))
    expect(Math.min(...ys)).toBeLessThan(100)
  })

  it('the shared-element note is used once and only while fresh', () => {
    const rect = { left: 10, top: 20, width: 300, height: 48 } as DOMRect
    noteAskOrigin('tab-1', rect)
    expect(takeAskOrigin('tab-2')).toBeNull()
    noteAskOrigin('tab-1', rect)
    expect(takeAskOrigin('tab-1')).toEqual({ left: 10, top: 20, width: 300, height: 48 })
    expect(takeAskOrigin('tab-1')).toBeNull()
    noteAskOrigin('tab-1', rect)
    expect(takeAskOrigin('tab-1', Date.now() + 10_000)).toBeNull()
  })
})

describe('welcome placements', () => {
  it('glides between centred, beside and corner placements, full body and bust', () => {
    expect(welcomePlacement(0)).toMatchObject({ where: 'center', framing: 'full' })
    expect(welcomePlacement(1)).toMatchObject({ where: 'side', framing: 'full' })
    expect(welcomePlacement(2).framing).toBe('bust')
    expect(welcomePlacement(99)).toEqual(welcomePlacement(4))
    expect(welcomePlacement(-3)).toEqual(welcomePlacement(0))
  })

  it('opens with the dawn unless motion is reduced', () => {
    expect(welcomeIntro(false).phase).toBe('mark')
    expect(welcomeIntro(true)).toEqual({ phase: 'done', markMs: 0, totalMs: 0 })
  })
})

describe('readable companion names (DS-139)', () => {
  const presets = JSON.parse(readFileSync(new URL('../src/renderer/public/companion/config/presets.json', import.meta.url), 'utf8')) as CompanionPreset[]

  it('every preset look reads at 4.5:1 on the raised surface in both modes', () => {
    expect(presets.length).toBeGreaterThan(0)
    for (const preset of presets) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const color of Object.values(preset.look.colors)) {
          expect(contrastRatio(nameColor(color, scheme), RAISED[scheme])).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('pastels and near-blacks are moved until they read', () => {
    expect(contrastRatio(nameColor('#f4f0ff', 'light'), '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(nameColor('#120a2a', 'dark'), RAISED.dark)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the Lounge: a ground of glyphs, not a disc', () => {
  const card = { left: 300, top: 328, right: 940, bottom: 442 }
  const pond = pondLayout({ width: 1240, height: 820 }, card)

  it('centres on the pond, reaches past its rim and stays roughly round', () => {
    const feet = { x: 620, y: 292 }
    const g = floorGround(pond, feet)
    expect(g.left + g.width / 2).toBeCloseTo(pond.cx)
    expect(g.top + g.height / 2).toBeCloseTo(pond.cy)
    // Companions at the rim still stand on it, and it is far rounder than the flat pond.
    expect(g.width / 2).toBeGreaterThan(pond.rx * FLOOR.rim)
    expect(g.height / g.width).toBeGreaterThanOrEqual(GROUND.roundness - 1e-9)
    expect(g.height / g.width).toBeGreaterThan(pond.ry / pond.rx)
    expect(g.height).toBeLessThanOrEqual(g.width)
    // On a narrow stage it fades out by the sides instead of running past them.
    const narrow = floorGround(pondLayout({ width: 900, height: 700 }, null), null)
    expect(narrow.left).toBeGreaterThanOrEqual(-900 * 0.5 * (GROUND.sides - 1) - 1e-9)
  })

  it('rolls its swells out from the figure’s feet, which stand in its full-strength core', () => {
    const feet = { x: 620, y: 292 }
    const g = floorGround(pond, feet)
    expect(g.left + g.origin.x * g.width).toBeCloseTo(feet.x)
    expect(g.top + g.origin.y * g.height).toBeCloseTo(feet.y)
    expect(ellipseMask(feet.x - g.left, feet.y - g.top, g.width, g.height, FLOOR_CORE)).toBe(1)
    // A figure standing far above the pond stretches it, never past round.
    const high = floorGround(pond, { x: 620, y: -400 })
    expect(high.height).toBeCloseTo(high.width)
    // Without a figure, the swells start at the pond's back rim.
    const none = floorGround(pond, null)
    expect(none.origin.x).toBeCloseTo(0.5)
    expect(none.top + none.origin.y * none.height).toBeCloseTo(pond.cy - pond.ry * 0.72)
  })

  it('maps a landing to a point of the box, held inside it', () => {
    const g = floorGround(pond, { x: 620, y: 292 })
    expect(groundPoint(g, g.left + g.width / 4, g.top + g.height / 2)).toEqual({ x: 0.25, y: 0.5 })
    expect(groundPoint(g, -5000, 99999)).toEqual({ x: 0, y: 1 })
  })

  it('fades out to nothing toward its rim, with no hard edge', () => {
    const [w, h] = [1000, 500]
    expect(ellipseMask(500, 250, w, h, FLOOR_CORE)).toBe(1)
    expect(ellipseMask(500 + 0.4 * 500, 250, w, h, FLOOR_CORE)).toBe(1)
    expect(ellipseMask(1000, 250, w, h, FLOOR_CORE)).toBe(0)
    expect(ellipseMask(0, 0, w, h, FLOOR_CORE)).toBe(0)
    // Elliptical: the same fraction of the radius fades the same along either axis.
    expect(ellipseMask(500, 250 + 0.7 * 250, w, h, FLOOR_CORE)).toBeCloseTo(ellipseMask(500 + 0.7 * 500, 250, w, h, FLOOR_CORE))
    // Monotonic and gradual: no step anywhere from the core to the rim.
    let last = 1
    for (let r = FLOOR_CORE; r <= 1; r += 0.02) {
      const m = ellipseMask(500 + r * 500, 250, w, h, FLOOR_CORE)
      expect(m).toBeLessThanOrEqual(last + 1e-9)
      expect(last - m).toBeLessThan(0.1)
      last = m
    }
  })

  it('dims behind the composer and the ideas, and leaves the rest alone', () => {
    const zone = { left: 200, top: 100, right: 600, bottom: 300 }
    expect(clearingMask(400, 200, [zone])).toBeCloseTo(CLEARING.keep)
    expect(clearingMask(200 + CLEARING.inset, 200, [zone])).toBeCloseTo(CLEARING.keep)
    expect(clearingMask(400, 300 + CLEARING.reach, [zone])).toBe(1)
    expect(clearingMask(800, 200, [zone])).toBe(1)
    const edge = clearingMask(600, 200, [zone])
    expect(edge).toBeGreaterThan(CLEARING.keep)
    expect(edge).toBeLessThan(1)
    // Together with the ellipse: dimmed inside, untouched without a mask.
    expect(fieldMask(400, 200, 800, 400, { ellipse: FLOOR_CORE, clear: [zone] })).toBeCloseTo(CLEARING.keep)
    expect(fieldMask(400, 200, 800, 400, undefined)).toBe(1)
  })

  it('draws the ground with ShapeField, not dotted rings', () => {
    const floor = readFileSync(new URL('../src/renderer/src/components/newtab/Floor.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('../src/renderer/src/components/newtab/newtab.css', import.meta.url), 'utf8')
    expect(floor).toMatch(/<ShapeField[^>]*density="floor"/)
    expect(GROUND.core).toBe(FLOOR_CORE)
    expect(floor).not.toContain('nt-floor__ring')
    expect(css).not.toMatch(/nt-floor__(ring|pond|ripple)/)
  })
})
