/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The preset profile's pure parts: the companion you made from a
// preset, the four stat tiles and the skill a starter routine runs.
import type { Companion } from '@shared/companion'
import type { PresetDetail } from '@shared/onboarding'

/** The companion you already made from this preset (not hidden), if any. */
export function companionFromPreset<C extends Pick<Companion, 'persona' | 'hidden'>>(companions: readonly C[], presetId: string): C | null {
  return companions.find((c) => c.persona === presetId && !c.hidden) ?? null
}

export type PresetStatId = 'skills' | 'routines' | 'yours' | 'version'

/** The profile's four stat tiles: what it brings, how many of yours came from it, and its version. */
export function presetStats(detail: Pick<PresetDetail, 'presetId' | 'starterSkills' | 'starterRoutines' | 'version'>, companions: readonly Pick<Companion, 'persona'>[]): { id: PresetStatId; value: string }[] {
  return [
    { id: 'skills', value: String(detail.starterSkills.length) },
    { id: 'routines', value: String(detail.starterRoutines.length) },
    { id: 'yours', value: String(companions.filter((c) => c.persona === detail.presetId).length) },
    { id: 'version', value: detail.version ? `v${detail.version}` : 'v1' },
  ]
}

/** The skill a routine's prompt runs ("Use /fine-print on …" → fine-print), for the routine row's pill. */
export function routineSkill(prompt: string): string | null {
  const m = /(?:^|\s)\/([a-z0-9][a-z0-9-]{0,63})\b/.exec(prompt)
  return m ? (m[1] ?? null) : null
}

// ---- the detail views: one starter skill or routine, opened from the profile ----

/** Which starter a detail view shows. */
export interface PresetItemRef {
  kind: 'skill' | 'routine'
  name: string
}

export type PresetItem =
  | { kind: 'skill'; skill: PresetDetail['starterSkills'][number]; position: number; total: number }
  | { kind: 'routine'; routine: PresetDetail['starterRoutines'][number]; position: number; total: number }

type Starters = Pick<PresetDetail, 'starterSkills' | 'starterRoutines'>

/** The profile's order: skills, then routines. */
function starterRefs(detail: Starters): PresetItemRef[] {
  return [...detail.starterSkills.map((s) => ({ kind: 'skill' as const, name: s.name })), ...detail.starterRoutines.map((r) => ({ kind: 'routine' as const, name: r.name }))]
}

/** The starter a detail view shows, with its place in the profile's order (1-based), or null once it is gone (an update dropped it). */
export function presetItem(detail: Starters, ref: PresetItemRef | null): PresetItem | null {
  if (!ref) return null
  const refs = starterRefs(detail)
  const position = refs.findIndex((r) => r.kind === ref.kind && r.name === ref.name) + 1
  if (position === 0) return null
  if (ref.kind === 'skill') {
    const skill = detail.starterSkills.find((s) => s.name === ref.name)
    return skill ? { kind: 'skill', skill, position, total: refs.length } : null
  }
  const routine = detail.starterRoutines.find((r) => r.name === ref.name)
  return routine ? { kind: 'routine', routine, position, total: refs.length } : null
}

/** The starter before (-1) or after (1) this one in the profile's order, for the detail view's arrows; null at either end. */
export function adjacentPresetItem(detail: Starters, ref: PresetItemRef, step: -1 | 1): PresetItemRef | null {
  const refs = starterRefs(detail)
  const at = refs.findIndex((r) => r.kind === ref.kind && r.name === ref.name)
  if (at < 0) return null
  return refs[at + step] ?? null
}

/** A skill's body for its detail view: its numbered steps when it has them, and its instructions as paragraphs. */
export function skillDetailBody(skill: { instructions: string; steps?: { id: string; title: string; instructions: string }[] }): { paragraphs: string[]; steps: { id: string; n: number; title: string; text: string }[] } {
  const paragraphs = skill.instructions
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const steps = (skill.steps ?? []).filter((s) => s.title.trim() || s.instructions.trim()).map((s, i) => ({ id: s.id, n: i + 1, title: s.title.trim(), text: s.instructions.trim() }))
  return { paragraphs, steps }
}

/** The starter routines that run this skill (by its id or a /name in the prompt), for the skill's detail view. */
export function routinesUsingSkill(detail: Pick<PresetDetail, 'starterRoutines'>, skillName: string): string[] {
  return detail.starterRoutines.filter((r) => r.skillId === skillName || routineSkill(r.prompt) === skillName).map((r) => r.name)
}

/** The skill a starter routine runs, when the preset brings it along (so the routine's detail can link to it). */
export function routineStarterSkill(detail: Pick<PresetDetail, 'starterSkills'>, routine: { prompt: string; skillId?: string }): string | null {
  const name = routine.skillId ?? routineSkill(routine.prompt)
  return name && detail.starterSkills.some((s) => s.name === name) ? name : null
}
