/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SKILL_NAME } from './stores'

// Skills as files, for the card's export and import: Markdown with a small
// front matter block holding the name and description, and the
// instructions as the body. Parsing is strict about the name (the same rule
// as saved skills) and forgiving about everything else. The
// skills service imports and exports through skills/format.ts (SKILL.md
// with steps); this helper stays for its older callers.

export const SKILL_FILE_EXTENSION = 'md'
export const SKILL_FILE_MAX_BYTES = 64 * 1024

function quote(value: string): string {
  // Plain values stay readable; anything YAML could misread is quoted.
  return /^[\w ./,()'-]*$/.test(value) && value.trim() === value ? value : JSON.stringify(value)
}

export function skillMarkdown(skill: { name: string; description: string; instructions: string }): string {
  return `---\nname: ${skill.name}\ndescription: ${quote(skill.description.replace(/\s+/g, ' ').trim())}\n---\n\n${skill.instructions.trim()}\n`
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

/** A name from a file name: "Weekly Report.md" → "weekly-report". */
export function skillNameFromFile(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/** The skill in a file's text. Throws a readable error when there is no usable name or instructions. */
export function parseSkillMarkdown(text: string, fileName = ''): { name: string; description: string; instructions: string } {
  if (Buffer.byteLength(text) > SKILL_FILE_MAX_BYTES) throw new Error('This skill file is too large to import.')
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let fields: Record<string, string> = {}
  let body = normalized
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (match) {
    fields = Object.fromEntries(
      (match[1] ?? '')
        .split('\n')
        .map((line) => /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!.toLowerCase(), unquote(m[2] ?? '')]),
    )
    body = match[2] ?? ''
  }
  const name = (fields.name ?? '').trim().toLowerCase() || skillNameFromFile(fileName)
  if (!SKILL_NAME.test(name)) throw new Error('This skill file has no usable name. Names use lowercase letters, digits and dashes.')
  const instructions = body.trim()
  if (!instructions) throw new Error('This skill file has no instructions.')
  return { name, description: (fields.description ?? '').slice(0, 500), instructions: instructions.slice(0, 20_000) }
}
