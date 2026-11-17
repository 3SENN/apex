/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// SKILL.md (SK-03): YAML front matter with the name and description, the
// instructions as the body, and a skill's ordered steps (the
// merged Workflows) after it as marked sections. Front matter keys Apex
// doesn't know are kept exactly as written, so a folder from elsewhere
// round-trips. Only the small YAML subset skill files use is read: plain,
// quoted and block-scalar values.
import { z } from 'zod'
import { SKILL_DESCRIPTION_MAX, SKILL_INSTRUCTIONS_MAX, SKILL_NAME_PATTERN, type SkillStep } from '@shared/skills'
import { mainT } from '../i18n/mainT'

export interface SkillDocument {
  name: string
  description: string
  instructions: string
  steps: SkillStep[]
  /** Raw front matter lines of keys other than name and description, in order. */
  extra: string[]
}

export const frontMatterSchema = z.object({
  name: z.string().regex(SKILL_NAME_PATTERN, { error: () => mainT('skills.mainFormat.namesUseLowercaseLetters') }),
  description: z.string().min(1, { error: () => mainT('skills.mainFormat.addADescriptionOne') }).max(SKILL_DESCRIPTION_MAX, { error: () => mainT('skills.mainFormat.keepTheDescriptionTo', { SKILL_DESCRIPTION_MAX }) }),
})

const STEP_MARK = /^<!-- apex:step (\{.*\}) -->$/

function quote(value: string): string {
  // Plain values stay readable; anything YAML could misread is quoted.
  return /^[\w ./,()'-]*$/.test(value) && value.trim() === value && value !== '' ? value : JSON.stringify(value)
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(v)
      if (typeof parsed === 'string') return parsed
    } catch {
      // Fall through to the raw text.
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'")
  return v
}

/** Splits front matter into known fields and the raw lines of everything else. */
function readFrontMatter(block: string): { fields: Record<string, string>; extra: string[] } {
  const fields: Record<string, string> = {}
  const extra: string[] = []
  const lines = block.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    // Continuation lines (indented, list items) belong to the key above.
    const continuation: string[] = []
    while (i + 1 < lines.length && /^(\s+|- )/.test(lines[i + 1] ?? '') ) continuation.push(lines[++i] ?? '')
    const key = m?.[1]?.toLowerCase()
    if (m && (key === 'name' || key === 'description')) {
      const raw = (m[2] ?? '').trim()
      if (/^[>|][-+]?$/.test(raw)) {
        const text = continuation.map((l) => l.trim())
        fields[key] = raw.startsWith('>') ? text.filter(Boolean).join(' ') : text.join('\n').trim()
      } else {
        fields[key] = [unquote(raw), ...continuation.map((l) => l.trim())].filter(Boolean).join(' ')
      }
    } else if (line.trim() !== '' || continuation.length > 0) {
      extra.push(line, ...continuation)
    }
  }
  return { fields, extra }
}

/** Instructions, then the step sections. */
function readBody(body: string): { instructions: string; steps: SkillStep[] } {
  const steps: SkillStep[] = []
  const head: string[] = []
  let current: { step: SkillStep; lines: string[] } | null = null
  const close = (): void => {
    if (current) steps.push({ ...current.step, instructions: current.lines.join('\n').trim() })
  }
  for (const line of body.split('\n')) {
    const mark = STEP_MARK.exec(line.trim())
    if (mark) {
      close()
      let parsed: unknown = null
      try {
        parsed = JSON.parse(mark[1] ?? '')
      } catch {
        parsed = null
      }
      const p = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
      current = { step: { id: typeof p.id === 'string' && p.id ? p.id.slice(0, 64) : `step-${steps.length + 1}`, title: typeof p.title === 'string' ? p.title.slice(0, 200) : '', instructions: '' }, lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else head.push(line)
  }
  close()
  return { instructions: head.join('\n').trim(), steps }
}

export interface ParseOptions {
  /** Used when the front matter has no name (an imported file). */
  fileName?: string
  /** Fill a missing description from the first line of the instructions (imports). */
  deriveDescription?: boolean
}

/** A name from a file name: "Weekly Report.md" → "weekly-report". */
export function skillNameFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

function firstSentence(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  return line.length > SKILL_DESCRIPTION_MAX ? `${line.slice(0, SKILL_DESCRIPTION_MAX - 1)}…` : line
}

/** Parses SKILL.md text. Throws a readable error naming what is missing or wrong. */
export function parseSkillDocument(text: string, options: ParseOptions = {}): SkillDocument {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!normalized.trim()) throw new Error('This skill file is empty.')
  let fields: Record<string, string> = {}
  let extra: string[] = []
  let body = normalized
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(normalized)
  if (match) {
    ;({ fields, extra } = readFrontMatter(match[1] ?? ''))
    body = match[2] ?? ''
  } else if (normalized.startsWith('---\n')) {
    throw new Error('The front matter at the top of this file isn’t closed with “---”.')
  }
  const { instructions, steps } = readBody(body)
  if (!instructions && steps.length === 0) throw new Error('This skill has no instructions.')
  if (instructions.length > SKILL_INSTRUCTIONS_MAX) throw new Error('These instructions are too long for a skill.')
  const name = (fields.name ?? '').trim().toLowerCase() || (options.fileName ? skillNameFromFile(options.fileName) : '')
  let description = (fields.description ?? '').trim()
  if (!description && options.deriveDescription) description = firstSentence(instructions || (steps[0]?.instructions ?? ''))
  const checked = frontMatterSchema.safeParse({ name, description })
  if (!checked.success) throw new Error(checked.error.issues[0]?.message ?? 'This skill’s name or description isn’t valid.')
  return { name: checked.data.name, description: checked.data.description, instructions, steps, extra }
}

/** SKILL.md text for a skill; unknown front matter goes after name and description, unchanged. */
export function serializeSkillDocument(doc: Pick<SkillDocument, 'name' | 'description' | 'instructions' | 'steps'> & { extra?: string[] }): string {
  const head = ['---', `name: ${doc.name}`, `description: ${quote(doc.description.replace(/\s+/g, ' ').trim())}`, ...(doc.extra ?? []), '---']
  const parts = [head.join('\n'), '', doc.instructions.trim()]
  for (const step of doc.steps) {
    parts.push('', `<!-- apex:step ${JSON.stringify({ id: step.id, title: step.title })} -->`, step.instructions.trim())
  }
  return `${parts.join('\n').trimEnd()}\n`
}

/**
 * What a chat sees for /name: the instructions, then the steps
 * numbered in order, inside one skill block.
 */
export function skillBlock(skill: { name: string; instructions: string; steps?: readonly SkillStep[] }): string {
  const lines = [skill.instructions.trim()]
  const steps = skill.steps ?? []
  if (steps.length > 0) {
    lines.push('', 'Work through these steps in order:')
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title || `Step ${i + 1}`}`)
      const body = s.instructions.trim()
      if (body) lines.push(...body.split('\n').map((l) => `   ${l}`))
    })
  }
  return `<skill name="${skill.name}">\n${lines.join('\n').trim()}\n</skill>`
}
