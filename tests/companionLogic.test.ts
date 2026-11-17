/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  COMPANION_MOODS,
  DEFAULT_LOOK,
  FACE_IDS,
  MOOD_FACE,
  PART_IDS,
  PART_SLOTS,
  type AnimationEvent,
  type CompanionLook,
  type CompatibilityConfig,
  type FacePartDef,
  type RandomizationConfig,
} from '../src/shared/companion'
import {
  canBlink,
  cheekColor,
  darkenHex,
  decayTalk,
  dueEvents,
  hexToRgb,
  fitsWithHat,
  isHexColor,
  isPartAllowed,
  lookKey,
  mixHex,
  modelKey,
  moodGaze,
  nextBlinkDelay,
  normalizeLook,
  outlineColor,
  randomizeLook,
  resolveFace,
  sameLook,
  seededRng,
  showsPupils,
  talkMouth,
  weightedPick,
} from '../src/shared/companionLogic'

const compat: CompatibilityConfig = {
  'head-round': { ears: 'all', hair: 'all', hat: 'all', eyeAccessory: 'all', earAccessory: 'all' },
  'head-cloud': { ears: [], hair: ['hair-tuft'], hat: ['hat-beanie', 'hat-crown'], eyeAccessory: ['glasses-round'], earAccessory: [] },
  // Keyed by hat: what a look wearing it accepts.
  'hat-beanie': { ears: ['ears-cat'], hair: ['hair-tuft', 'hair-bob'], hat: 'all', eyeAccessory: 'all', earAccessory: 'all' },
}

const look = (patch: Partial<CompanionLook['parts']> = {}): CompanionLook => ({
  ...DEFAULT_LOOK,
  parts: { ...DEFAULT_LOOK.parts, ...patch },
})

describe('isPartAllowed', () => {
  it('accepts anything for heads marked all, and empty slots everywhere', () => {
    expect(isPartAllowed(compat, 'head-round', 'hat', 'hat-wizard')).toBe(true)
    expect(isPartAllowed(compat, 'head-cloud', 'hat', null)).toBe(true)
    expect(isPartAllowed(compat, 'head-cloud', 'ears', null)).toBe(true)
  })

  it('applies per-head lists', () => {
    expect(isPartAllowed(compat, 'head-cloud', 'hat', 'hat-crown')).toBe(true)
    expect(isPartAllowed(compat, 'head-cloud', 'hat', 'hat-wizard')).toBe(false)
    expect(isPartAllowed(compat, 'head-cloud', 'ears', 'ears-cat')).toBe(false)
    expect(isPartAllowed(compat, 'head-cloud', 'hair', 'hair-tuft')).toBe(true)
  })

  it('rejects ids from another slot or outside the catalogue', () => {
    expect(isPartAllowed(compat, 'head-round', 'hat', 'ears-cat')).toBe(false)
    expect(isPartAllowed(compat, 'head-round', 'hat', 'hat-sombrero')).toBe(false)
    expect(isPartAllowed(compat, 'head-round', 'head', 'head-triangle')).toBe(false)
  })

  it('never allows an empty head, always allows props and known heads', () => {
    expect(isPartAllowed(compat, 'head-round', 'head', null)).toBe(false)
    expect(isPartAllowed(compat, 'head-cloud', 'head', 'head-drop')).toBe(true)
    expect(isPartAllowed(compat, 'head-cloud', 'prop', 'prop-wand')).toBe(true)
  })

  it('treats a head without rules as accepting everything', () => {
    expect(isPartAllowed(compat, 'head-bean', 'ears', 'ears-bunny')).toBe(true)
    expect(isPartAllowed({}, 'head-round', 'hair', 'hair-bob')).toBe(true)
  })
})

describe('fitsWithHat', () => {
  it('applies the hat entries, and anything goes without a hat, a part or a rule', () => {
    expect(fitsWithHat(compat, 'hat-beanie', 'hair', 'hair-bob')).toBe(true)
    expect(fitsWithHat(compat, 'hat-beanie', 'hair', 'hair-mohawk')).toBe(false)
    expect(fitsWithHat(compat, 'hat-beanie', 'ears', 'ears-bear')).toBe(false)
    expect(fitsWithHat(compat, 'hat-beanie', 'ears', 'ears-cat')).toBe(true)
    expect(fitsWithHat(compat, 'hat-beanie', 'prop', 'prop-wand')).toBe(true)
    expect(fitsWithHat(compat, 'hat-crown', 'hair', 'hair-mohawk')).toBe(true)
    expect(fitsWithHat(compat, null, 'hair', 'hair-mohawk')).toBe(true)
    expect(fitsWithHat(compat, 'hat-beanie', 'hair', null)).toBe(true)
  })

  it('lets the hat win in normalizeLook', () => {
    const worn = normalizeLook(look({ head: 'head-round', hair: 'hair-mohawk', ears: 'ears-bear', hat: 'hat-beanie' }), compat)
    expect(worn.parts.hat).toBe('hat-beanie')
    expect(worn.parts.hair).toBeNull()
    expect(worn.parts.ears).toBeNull()
    expect(normalizeLook(worn, compat)).toEqual(worn)
    expect(normalizeLook(look({ head: 'head-round', hair: 'hair-bob', hat: 'hat-beanie' }), compat).parts.hair).toBe('hair-bob')
  })
})

describe('normalizeLook', () => {
  it('keeps a valid look unchanged', () => {
    const valid = look({ hat: 'hat-wizard', prop: 'prop-book', ears: 'ears-cat' })
    expect(normalizeLook(valid, compat)).toEqual(valid)
  })

  it('drops parts the head does not accept', () => {
    const result = normalizeLook(look({ head: 'head-cloud', hair: 'hair-bob', hat: 'hat-crown', ears: 'ears-cat', eyeAccessory: 'visor' }), compat)
    expect(result.parts).toEqual({ head: 'head-cloud', ears: null, hair: null, hat: 'hat-crown', eyeAccessory: null, earAccessory: null, prop: null })
  })

  it('replaces unknown rig, head, face ids and colours with defaults', () => {
    const result = normalizeLook(
      {
        rig: 'Z',
        parts: { head: 'head-triangle', hat: 'ears-cat', prop: 'prop-sword' },
        face: { eyes: 'eyes-laser', brows: 'brows-bold', mouth: 42 },
        colors: { skin: 'red', hair: '#ABCDEF', accent: '#12345', outfit: null },
      },
      compat,
    )
    expect(result.rig).toBe(DEFAULT_LOOK.rig)
    expect(result.parts.head).toBe(DEFAULT_LOOK.parts.head)
    expect(result.parts.hat).toBeNull()
    expect(result.parts.prop).toBeNull()
    expect(result.face).toEqual({ eyes: DEFAULT_LOOK.face.eyes, brows: 'brows-bold', mouth: DEFAULT_LOOK.face.mouth })
    expect(result.colors).toEqual({ skin: DEFAULT_LOOK.colors.skin, hair: '#abcdef', accent: DEFAULT_LOOK.colors.accent, outfit: DEFAULT_LOOK.colors.outfit })
  })

  it('turns missing or empty input into the default look', () => {
    expect(normalizeLook(undefined, compat)).toEqual(DEFAULT_LOOK)
    expect(normalizeLook({}, compat)).toEqual(DEFAULT_LOOK)
    expect(normalizeLook({ parts: null, face: null, colors: null }, compat)).toEqual(DEFAULT_LOOK)
  })

  it('is idempotent and does not mutate its input', () => {
    const input = look({ head: 'head-cloud', hair: 'hair-curls', hat: 'hat-beanie' })
    const copy = structuredClone(input)
    const once = normalizeLook(input, compat)
    expect(normalizeLook(once, compat)).toEqual(once)
    expect(input).toEqual(copy)
    expect(once.parts).not.toBe(DEFAULT_LOOK.parts)
  })
})

describe('look keys', () => {
  it('compare looks by value, and separate model changes from colour changes', () => {
    const a = look({ hat: 'hat-cap' })
    const recoloured = { ...a, colors: { ...a.colors, skin: '#000000' } }
    expect(sameLook(a, structuredClone(a))).toBe(true)
    expect(sameLook(a, recoloured)).toBe(false)
    expect(modelKey(a)).toBe(modelKey(recoloured))
    expect(modelKey(a)).not.toBe(modelKey(look({ hat: 'hat-beret' })))
    expect(lookKey(a)).not.toBe(lookKey(look({ hat: 'hat-beret' })))
  })
})

describe('weightedPick', () => {
  const items = [
    { id: 'a', weight: 1 },
    { id: 'b', weight: 3 },
    { id: 'zero', weight: 0 },
    { id: 'neg', weight: -5 },
  ]

  it('maps rng ranges to items in proportion to weight', () => {
    expect(weightedPick(items, () => 0)?.id).toBe('a')
    expect(weightedPick(items, () => 0.24)?.id).toBe('a')
    expect(weightedPick(items, () => 0.26)?.id).toBe('b')
    expect(weightedPick(items, () => 0.999999)?.id).toBe('b')
  })

  it('never picks zero or negative weights, even with a broken rng', () => {
    for (const r of [0, 0.5, 1, 1.5, -1, Number.NaN]) {
      expect(['a', 'b']).toContain(weightedPick(items, () => r)?.id)
    }
  })

  it('returns undefined when nothing has weight', () => {
    expect(weightedPick([], Math.random)).toBeUndefined()
    expect(weightedPick([{ weight: 0 }], Math.random)).toBeUndefined()
  })

  it('follows the weights over many draws', () => {
    const rng = seededRng(7)
    let b = 0
    for (let i = 0; i < 4000; i++) if (weightedPick(items, rng)?.id === 'b') b++
    expect(b / 4000).toBeGreaterThan(0.7)
    expect(b / 4000).toBeLessThan(0.8)
  })
})

describe('randomizeLook', () => {
  const uniform = <T extends string | null>(ids: readonly T[]) => ids.map((id) => ({ id, weight: 1 }))
  const randomization: RandomizationConfig = {
    rig: [
      { id: 'A', weight: 2 },
      { id: 'B', weight: 1 },
      { id: 'C', weight: 1 },
    ],
    slots: {
      head: uniform(['head-round', 'head-cloud'] as const),
      ears: uniform([null, ...PART_IDS.ears]),
      hair: uniform([null, ...PART_IDS.hair]),
      hat: uniform([null, ...PART_IDS.hat]),
      eyeAccessory: uniform([null, ...PART_IDS.eyeAccessory]),
      earAccessory: uniform([null, ...PART_IDS.earAccessory]),
      prop: uniform([null, ...PART_IDS.prop, 'prop-unknown']),
    },
    face: {
      eyes: uniform(FACE_IDS.eyes),
      brows: uniform(FACE_IDS.brows),
      mouth: uniform(FACE_IDS.mouth),
    },
    palettes: [
      { name: 'Night', weight: 1, colors: { skin: '#223344', hair: '#111111', accent: '#ffcc00', outfit: '#334455' } },
      { name: 'Mint', weight: 1, colors: { skin: '#66ddbb', hair: '#226655', accent: '#ccffee', outfit: '#118866' } },
    ],
  }

  it('only produces compatible looks', () => {
    const rng = seededRng(1)
    for (let i = 0; i < 300; i++) {
      const result = randomizeLook(randomization, compat, rng)
      expect(normalizeLook(result, compat)).toEqual(result)
      for (const slot of PART_SLOTS) expect(isPartAllowed(compat, result.parts.head as string, slot, result.parts[slot])).toBe(true)
      for (const slot of PART_SLOTS) expect(fitsWithHat(compat, result.parts.hat, slot, result.parts[slot])).toBe(true)
      expect(result.parts.prop).not.toBe('prop-unknown')
    }
  })

  it('is reproducible with a seeded rng and varied across seeds', () => {
    expect(randomizeLook(randomization, compat, seededRng(42))).toEqual(randomizeLook(randomization, compat, seededRng(42)))
    const keys = new Set(Array.from({ length: 20 }, (_, i) => lookKey(randomizeLook(randomization, compat, seededRng(i)))))
    expect(keys.size).toBeGreaterThan(15)
  })

  it('uses palettes and covers every rig', () => {
    const rng = seededRng(3)
    const rigs = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const result = randomizeLook(randomization, compat, rng)
      rigs.add(result.rig)
      expect(['#223344', '#66ddbb']).toContain(result.colors.skin)
    }
    expect(rigs).toEqual(new Set(['A', 'B', 'C']))
  })

  it('falls back to defaults when the config is empty', () => {
    const empty: RandomizationConfig = {
      rig: [],
      slots: { head: [], ears: [], hair: [], hat: [], eyeAccessory: [], earAccessory: [], prop: [] },
      face: { eyes: [], brows: [], mouth: [] },
      palettes: [],
    }
    const result = randomizeLook(empty, compat, Math.random)
    expect(result.rig).toBe(DEFAULT_LOOK.rig)
    expect(result.parts).toEqual({ ...DEFAULT_LOOK.parts, hair: null })
    expect(result.face).toEqual(DEFAULT_LOOK.face)
    expect(result.colors).toEqual(DEFAULT_LOOK.colors)
  })
})

describe('dueEvents', () => {
  const events: AnimationEvent[] = [
    { t: 1.5, type: 'sparkle' },
    { t: 0, type: 'blink' },
    { t: 0.5, type: 'squash', amount: 0.1 },
    { t: 2.9, type: 'prop', visible: false },
  ]
  const types = (list: AnimationEvent[]) => list.map((e) => e.type)

  it('returns events crossed in (prev, time], in time order', () => {
    expect(types(dueEvents(events, 0.4, 1.6, 3))).toEqual(['squash', 'sparkle'])
    expect(types(dueEvents(events, 0.5, 1.4, 3))).toEqual([])
    expect(types(dueEvents(events, 1.4, 1.5, 3))).toEqual(['sparkle'])
  })

  it('fires t = 0 cues on the first frame when prev is negative', () => {
    expect(types(dueEvents(events, -1, 0.016, 3))).toEqual(['blink'])
  })

  it('handles loop wrap: the tail of the clip, then its start', () => {
    expect(types(dueEvents(events, 2.8, 0.6, 3))).toEqual(['prop', 'blink', 'squash'])
    expect(types(dueEvents(events, 2.95, 0.1, 3))).toEqual(['blink'])
  })

  it('never fires an event twice across consecutive frames', () => {
    const fired: string[] = []
    let prev = -1
    const duration = 3
    for (let frame = 1; frame <= 400; frame++) {
      const time = (frame * 0.0167) % duration
      fired.push(...types(dueEvents(events, prev, time, duration)))
      prev = time
    }
    // 400 frames ≈ 6.7 s ≈ 2.2 loops: each cue fires once per loop it was crossed.
    expect(fired.filter((t) => t === 'sparkle')).toHaveLength(2)
    expect(fired.filter((t) => t === 'blink')).toHaveLength(3)
    expect(fired.filter((t) => t === 'prop')).toHaveLength(2)
  })

  it('is empty when paused, without events or without a duration', () => {
    expect(dueEvents(events, 1, 1, 3)).toEqual([])
    expect(dueEvents([], 0, 1, 3)).toEqual([])
    expect(dueEvents(events, 0, 1, 0)).toEqual([])
  })

  it('does not reorder or mutate the source list', () => {
    const copy = structuredClone(events)
    dueEvents(events, 2.8, 0.6, 3)
    expect(events).toEqual(copy)
  })
})

describe('face resolution', () => {
  it('rests on the mood face', () => {
    for (const mood of COMPANION_MOODS) expect(resolveFace({ mood })).toEqual(MOOD_FACE[mood])
  })

  it('layers expression cues over the mood face', () => {
    expect(resolveFace({ mood: 'idle', expression: { mouth: 'o' } })).toEqual({ ...MOOD_FACE.idle, mouth: 'o' })
    expect(resolveFace({ mood: 'sad', expression: { eyes: 'happy', brows: 'raised' } })).toEqual({ eyes: 'happy', brows: 'raised', mouth: 'sad' })
  })

  it('blinks open eyes but not closed or squinting ones', () => {
    expect(resolveFace({ mood: 'idle', blinking: true }).eyes).toBe('blink')
    expect(resolveFace({ mood: 'happy', blinking: true }).eyes).toBe('happy')
    expect(resolveFace({ mood: 'sleeping', blinking: true }).eyes).toBe('sleepy')
    expect(canBlink('neutral')).toBe(true)
    expect(canBlink('blink')).toBe(false)
  })

  it('moves the mouth only while talking with energy', () => {
    expect(resolveFace({ mood: 'talking', talk: 0, time: 1 }).mouth).toBe(MOOD_FACE.talking.mouth)
    expect(resolveFace({ mood: 'idle', talk: 1, time: 1 }).mouth).toBe(MOOD_FACE.idle.mouth)
    const mouths = new Set(Array.from({ length: 120 }, (_, i) => resolveFace({ mood: 'talking', talk: 1, time: i / 60 }).mouth))
    expect(mouths).toEqual(new Set(['talk-small', 'talk-wide']))
  })

  it('talk mouth: quiet is null, low energy stays small', () => {
    expect(talkMouth(0, 1)).toBeNull()
    expect(talkMouth(0.05, 1)).toBeNull()
    for (let i = 0; i < 100; i++) expect(talkMouth(0.3, i / 37)).toBe('talk-small')
  })

  it('talk energy fades in about half a second', () => {
    expect(decayTalk(1, 0.25)).toBeCloseTo(0.45)
    expect(decayTalk(0.1, 1)).toBe(0)
  })

  it('schedules blinks 2.5–5 s apart', () => {
    expect(nextBlinkDelay(() => 0)).toBe(2.5)
    expect(nextBlinkDelay(() => 0.5)).toBe(3.75)
    expect(nextBlinkDelay(() => 1)).toBeLessThanOrEqual(5)
    expect(nextBlinkDelay(() => Number.NaN)).toBe(2.5)
  })

  it('shows pupils only for the listed variants', () => {
    const def: FacePartDef = { label: 'Round', variants: {}, pupils: 'face/eyes-round/pupils.svg', pupilVariants: ['neutral', 'wide'] }
    expect(showsPupils(def, 'neutral')).toBe(true)
    expect(showsPupils(def, 'blink')).toBe(false)
    expect(showsPupils(def, 'focused')).toBe(false)
    expect(showsPupils({ ...def, pupilVariants: undefined }, 'focused')).toBe(true)
    expect(showsPupils({ ...def, pupilVariants: undefined }, 'happy')).toBe(false)
    expect(showsPupils({ label: 'Dot', variants: {} }, 'neutral')).toBe(false)
    expect(showsPupils(undefined, 'neutral')).toBe(false)
  })
})

describe('moodGaze', () => {
  it('follows the pointer when attentive, clamped to the unit square', () => {
    expect(moodGaze('idle', { x: 0.4, y: -0.2 })).toEqual({ x: 0.4, y: -0.2 })
    expect(moodGaze('listening', { x: 3, y: -9 })).toEqual({ x: 1, y: -1 })
    expect(moodGaze('talking', { x: 1, y: 1 })).toEqual({ x: 0.6, y: 0.6 })
  })

  it('looks away on its own when busy, sad or asleep', () => {
    expect(moodGaze('thinking', { x: 1, y: -1 })).toEqual({ x: -0.5, y: 0.55 })
    expect(moodGaze('working', { x: 1, y: 1 }).y).toBeLessThan(0)
    expect(moodGaze('sad', { x: 1, y: 1 })).toEqual({ x: 0, y: -0.5 })
    expect(moodGaze('sleeping', { x: Number.NaN, y: 1 })).toEqual({ x: 0, y: -0.2 })
  })
})

describe('colour helpers', () => {
  it('validates and converts hex colours', () => {
    expect(isHexColor('#a1B2c3')).toBe(true)
    expect(isHexColor('#abc')).toBe(false)
    expect(isHexColor(123)).toBe(false)
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0])
    expect(hexToRgb('nope')).toEqual([0, 0, 0])
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff')
  })

  it('darkens for outlines while keeping the hue', () => {
    const [r, g, b] = hexToRgb(outlineColor('#8f74f8'))
    expect(r + g + b).toBeLessThan((0x8f + 0x74 + 0xf8) / 2)
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
    expect(darkenHex('#808080', 0.5)).toBe('#404040')
    expect(darkenHex('#ff0000', 1)).toBe('#ff0000')
  })

  it('makes a pinkish blush', () => {
    const [r, , b] = hexToRgb(cheekColor('#62d6b3'))
    expect(r).toBeGreaterThan(b)
    expect(isHexColor(cheekColor('#000000'))).toBe(true)
  })
})
