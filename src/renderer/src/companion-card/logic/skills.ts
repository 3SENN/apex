/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { t } from '@shared/i18n/core'
// Skill names as the card edits them. Main checks the same rule
// (SKILL_NAME in src/main/stores.ts) and is the one that decides.

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** What typing into the name field becomes: lowercase, spaces as dashes, nothing else. */
export function skillNameInput(raw: string): string {
  return raw.toLowerCase().replace(/^\//, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)
}

/** Every word of the query appears in the name or the description. */
export function skillMatches(skill: { name: string; description: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = `${skill.name} ${skill.description}`.toLowerCase()
  return words.every((w) => haystack.includes(w))
}


export interface SkillStepForm {
  id: string
  title: string
  instructions: string
}

export interface SkillForm {
  name: string
  description: string
  instructions: string
  steps: SkillStepForm[]
  owner: string
}

export type SkillFormField = 'name' | 'description' | 'instructions'

/** Each field's own problem (the same rules as SKILL.md's front matter); empty when it can be saved. */
export function skillFormErrors(form: SkillForm): Partial<Record<SkillFormField, string>> {
  const errors: Partial<Record<SkillFormField, string>> = {}
  if (!form.name) errors.name = t('coCard.skills.giveTheSkillA')
  else if (!SKILL_NAME.test(form.name)) errors.name = t('coCard.skills.useLowercaseLettersDigits')
  const description = form.description.trim()
  if (!description) errors.description = t('coCard.skills.sayInALine')
  else if (description.length > 500) errors.description = t('coCard.skills.keepItTo500', { length: description.length })
  const hasStep = form.steps.some((s) => s.title.trim() || s.instructions.trim())
  if (!form.instructions.trim() && !hasStep) errors.instructions = t('coCard.skills.writeTheInstructionsOr')
  return errors
}

/** Whether a form differs from what was loaded (Save, and the prompt before discarding). */
export function skillFormDirty(a: SkillForm, b: SkillForm): boolean {
  return JSON.stringify(normalizeForm(a)) !== JSON.stringify(normalizeForm(b))
}

function normalizeForm(f: SkillForm): SkillForm {
  return {
    name: f.name,
    description: f.description.trim(),
    instructions: f.instructions.trim(),
    owner: f.owner,
    steps: f.steps.map((s) => ({ id: s.id, title: s.title.trim(), instructions: s.instructions.trim() })).filter((s) => s.title || s.instructions),
  }
}

/** What `skills.save` takes from a form. */
export function skillFormInput(form: SkillForm, id?: string): { id?: string; name: string; description: string; instructions: string; steps: SkillStepForm[]; owner: string } {
  const n = normalizeForm(form)
  return { ...(id ? { id } : {}), ...n }
}

let stepCounter = 0
/** A fresh step id, unique in this window. */
export function newStepId(existing: readonly { id: string }[]): string {
  const taken = new Set(existing.map((s) => s.id))
  let id: string
  do id = `step-${Date.now().toString(36)}-${(stepCounter++).toString(36)}`
  while (taken.has(id))
  return id
}

/** Moves the step at `index` by `delta` places, clamped. */
export function moveStep<T>(steps: readonly T[], index: number, delta: number): T[] {
  const to = Math.max(0, Math.min(steps.length - 1, index + delta))
  if (to === index || index < 0 || index >= steps.length) return [...steps]
  const out = [...steps]
  const [item] = out.splice(index, 1)
  out.splice(to, 0, item as T)
  return out
}

/** "12 KB", "3.4 MB". */
export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The update-date filter of the Skills page. */
export type UpdatedWithin = 'any' | 'week' | 'month' | 'year'
export function updatedSince(within: UpdatedWithin, now = Date.now()): number | undefined {
  const day = 86_400_000
  return within === 'week' ? now - 7 * day : within === 'month' ? now - 30 * day : within === 'year' ? now - 365 * day : undefined
}
