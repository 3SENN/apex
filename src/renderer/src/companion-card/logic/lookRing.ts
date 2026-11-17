/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FACE_IDS, PART_IDS, PART_SLOTS, RIGS, TINTS, type CompanionLook, type CompatibilityConfig, type FaceLayer, type PartSlot, type RandomizationConfig, type RigId, type Tint } from '@shared/companion'
import { fitsWithHat, isPartAllowed, normalizeLook } from '@shared/companionLogic'
import { t } from '@shared/i18n/core'

// The look editor's stage (DS-118, DS-119): eight category bubbles on a ring
// around the figure, and the floating option panel each one opens. Pure, so
// the layout, the keyboard and the panel contents are unit-tested in node.

export type RingCategoryId = 'colours' | 'shape' | 'eyes' | 'mouth' | 'brows' | 'hat' | 'hair' | 'accessories'

/** Which adjustment group's sliders sit under a category's panel (DS-120). */
export type RingAdjustGroup = 'head' | 'eyes' | 'mouth' | 'brows' | 'accessory'

export interface RingCategory {
  id: RingCategoryId
  label: string
  /** The arc it sits on; its panel anchors to the hero edge on that side. */
  side: 'left' | 'right'
  /** 0 to 3, top to bottom along its arc. */
  row: 0 | 1 | 2 | 3
  adjust: RingAdjustGroup | null
}

/** Left arc, then right arc, each top to bottom: also the tab order. */
export const RING_CATEGORIES: readonly RingCategory[] = [
  { id: 'colours', get label() { return t('coCard.lookRing.colours') }, side: 'left', row: 0, adjust: null },
  { id: 'shape', get label() { return t('coCard.lookRing.shape') }, side: 'left', row: 1, adjust: 'head' },
  { id: 'eyes', get label() { return t('coCard.lookRing.eyes') }, side: 'left', row: 2, adjust: 'eyes' },
  { id: 'mouth', get label() { return t('coCard.lookRing.mouth') }, side: 'left', row: 3, adjust: 'mouth' },
  { id: 'brows', get label() { return t('coCard.lookRing.brows') }, side: 'right', row: 0, adjust: 'brows' },
  { id: 'hat', get label() { return t('coCard.lookRing.hat') }, side: 'right', row: 1, adjust: null },
  { id: 'hair', get label() { return t('coCard.lookRing.hair') }, side: 'right', row: 2, adjust: null },
  { id: 'accessories', get label() { return t('coCard.lookRing.accessories') }, side: 'right', row: 3, adjust: 'accessory' },
]

/** Bubble size and the ring's radius, in CSS px. */
export const BUBBLE_SIZE = 46
export const RING_RADIUS = 204

/**
 * Where a bubble's centre sits relative to the figure's centre: the inner
 * pairs at (±168, ±120) and the outer pairs at (±198, ±42), all close to
 * the 204 px ring.
 */
export function ringOffset(category: Pick<RingCategory, 'side' | 'row'>): { x: number; y: number } {
  const outer = category.row === 1 || category.row === 2
  const x = outer ? 198 : 168
  const y = category.row === 0 ? -120 : category.row === 1 ? -42 : category.row === 2 ? 42 : 120
  return { x: category.side === 'left' ? -x : x, y }
}

/**
 * The arrow keys move around the ring as it looks: up and down along an arc
 * (wrapping), left and right to the same row on the other arc, Home and End
 * to the first and last bubble. Returns null for any other key.
 */
export function ringKeyTarget(index: number, key: string, count = RING_CATEGORIES.length): number | null {
  const perSide = count / 2
  const at = Math.min(Math.max(index, 0), count - 1)
  const side = at < perSide ? 0 : 1
  const row = at - side * perSide
  switch (key) {
    case 'ArrowDown':
      return side * perSide + ((row + 1) % perSide)
    case 'ArrowUp':
      return side * perSide + ((row - 1 + perSide) % perSide)
    case 'ArrowLeft':
    case 'ArrowRight':
      return (1 - side) * perSide + row
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** One headed group of round tiles in a panel. */
export type PanelSection =
  | { kind: 'rig'; title: string }
  | { kind: 'part'; title: string; slot: PartSlot; options: ReadonlyArray<string | null> }
  | { kind: 'face'; title: string; layer: FaceLayer; options: readonly string[] }
  | { kind: 'colours'; title: string }

function part(title: string, slot: PartSlot): PanelSection {
  // Every slot but the head can be left empty.
  const options: Array<string | null> = slot === 'head' ? [...PART_IDS.head] : [null, ...PART_IDS[slot]]
  return { kind: 'part', title, slot, options }
}

function face(title: string, layer: FaceLayer): PanelSection {
  return { kind: 'face', title, layer, options: FACE_IDS[layer] }
}

/** What a category's panel holds, in order. More than one section means headed sub-groups. */
export function panelSections(id: RingCategoryId): PanelSection[] {
  switch (id) {
    case 'colours':
      return [{ kind: 'colours', title: t('coCard.lookRing.colours') }]
    case 'shape':
      return [{ kind: 'rig', title: t('coCard.lookRing.body') }, part(t('coCard.lookRing.head'), 'head'), part(t('coCard.lookRing.ears'), 'ears')]
    case 'eyes':
      return [face(t('coCard.lookRing.eyes'), 'eyes')]
    case 'mouth':
      return [face(t('coCard.lookRing.mouth'), 'mouth')]
    case 'brows':
      return [face(t('coCard.lookRing.brows'), 'brows')]
    case 'hat':
      return [part(t('coCard.lookRing.hat'), 'hat')]
    case 'hair':
      return [part(t('coCard.lookRing.hair'), 'hair')]
    case 'accessories':
      return [part(t('coCard.lookRing.glasses'), 'eyeAccessory'), part(t('coCard.lookRing.earwear'), 'earAccessory'), part(t('coCard.lookRing.prop'), 'prop')]
  }
}

/** Is this tile the look's current choice? */
export function isCurrent(look: CompanionLook, section: PanelSection, option: string | null): boolean {
  if (section.kind === 'rig') return look.rig === option
  if (section.kind === 'part') return look.parts[section.slot] === option
  if (section.kind === 'face') return look.face[section.layer] === option
  return false
}

/** The rigs as tile options. */
export const RIG_OPTIONS: readonly string[] = RIGS

/** The swatch grid for one tint: each palette's colour for it, lower-cased and without repeats, in palette order. */
export function tintSwatches(palettes: RandomizationConfig['palettes'], tint: Tint): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const palette of palettes) {
    const colour = palette.colors[tint]?.toLowerCase()
    if (!colour || seen.has(colour)) continue
    seen.add(colour)
    out.push(colour)
  }
  return out
}

/** Is this palette exactly the look's colours? */
export function isCurrentPalette(look: CompanionLook, colours: Record<Tint, string>): boolean {
  return TINTS.every((t) => colours[t].toLowerCase() === look.colors[t].toLowerCase())
}

/**
 * The look after picking a tile. A part that does not go with the worn hat
 * takes the hat off (the latest pick wins), and with the compatibility rules
 * at hand the result is normalised the way the editor saves it, so a tile's
 * preview shows exactly what picking it gives.
 */
export function withOption(look: CompanionLook, section: PanelSection, option: string | null, compat: CompatibilityConfig | null): CompanionLook {
  let next: CompanionLook
  if (section.kind === 'rig') {
    if (!option || !(RIGS as readonly string[]).includes(option)) return look
    next = { ...look, rig: option as RigId }
  } else if (section.kind === 'face') {
    if (!option) return look
    next = { ...look, face: { ...look.face, [section.layer]: option } }
  } else if (section.kind === 'part') {
    const parts = { ...look.parts, [section.slot]: option }
    if (compat && !fitsWithHat(compat, parts.hat, section.slot, option)) parts.hat = null
    next = { ...look, parts }
  } else {
    return look
  }
  return compat ? normalizeLook(next, compat) : next
}

/** Why a part tile can't be picked, or what picking it replaces; null when there is nothing to say. */
export function partNote(look: CompanionLook, slot: PartSlot, option: string | null, compat: CompatibilityConfig | null, label: (id: string) => string): { allowed: boolean; note: string | null } {
  if (!compat) return { allowed: true, note: null }
  const head = look.parts.head ?? PART_IDS.head[0]
  if (!isPartAllowed(compat, head, slot, option)) return { allowed: false, note: t('coCard.lookRing.doesnTFitThe', { value: label(head).toLowerCase() }) }
  if (slot !== 'hat') return { allowed: true, note: null }
  const replaced = PART_SLOTS.flatMap((other) => {
    const worn = look.parts[other]
    return worn !== null && !fitsWithHat(compat, option, other, worn) ? [label(worn).toLowerCase()] : []
  })
  return { allowed: true, note: replaced.length > 0 ? t('coCard.lookRing.replacesThe', { value: replaced.join(' and ') }) : null }
}
