/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown, skillMarkdown, skillNameFromFile } from '../src/main/skillFiles'

describe('skill files', () => {
  it('round-trips a skill through Markdown', () => {
    const skill = { name: 'weekly-report', description: 'Sums up: my week, "briefly"', instructions: 'Step one.\n\nStep two.' }
    const text = skillMarkdown(skill)
    expect(text.startsWith('---\nname: weekly-report\n')).toBe(true)
    expect(parseSkillMarkdown(text)).toEqual(skill)
    // Plain descriptions stay unquoted.
    expect(skillMarkdown({ ...skill, description: 'Sums up my week' })).toContain('description: Sums up my week\n')
  })

  it('reads hand-written files', () => {
    const text = "﻿---\r\nName: Trip-Planner\r\ndescription: 'Plans trips, it''s handy'\r\nextra: ignored\r\n---\r\nFind flights.\r\n"
    expect(parseSkillMarkdown(text)).toEqual({ name: 'trip-planner', description: "Plans trips, it's handy", instructions: 'Find flights.' })
  })

  it('takes the name from the file when the front matter has none', () => {
    expect(parseSkillMarkdown('Just do the thing.', 'Weekly Report.md')).toEqual({ name: 'weekly-report', description: '', instructions: 'Just do the thing.' })
    expect(skillNameFromFile('  ~~Odd__Name!!.txt')).toBe('odd-name')
  })

  it('refuses files without a usable name or instructions', () => {
    expect(() => parseSkillMarkdown('---\nname: Bad Name\n---\nx')).toThrow('no usable name')
    expect(() => parseSkillMarkdown('---\nname: ok\n---\n   ')).toThrow('no instructions')
    expect(() => parseSkillMarkdown('body', '!!!.md')).toThrow('no usable name')
    expect(() => parseSkillMarkdown('x'.repeat(70 * 1024), 'big.md')).toThrow('too large')
  })
})
