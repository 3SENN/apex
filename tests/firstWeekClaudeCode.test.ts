/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { createQuickModel } from '../src/main/agent/quick'
import { STARTER_MODEL, curatedStarters, generateStarters, type StarterContext } from '../src/main/firstWeekStarters'
import { claudeQuickEngine } from '../src/engines/claude-code/main/quick'

// The getting-started page's starters on Claude Code (tests/firstWeek.test.ts has the rest).

describe('personal starters on Claude Code', () => {
  const context: StarterContext = {
    userName: 'Sam',
    companionName: 'Pip',
    instructions: 'Keep answers short.',
    memoryNotes: ['home.md: Lives in Ghent', 'food.md: Vegetarian'],
    connectors: ['Calendar'],
    recentSites: ['runners.example.com', 'news.example.org'],
  }
  const okStarters = { starters: curatedStarters().slice(0, 5).map(({ title, description, prompt, glyph }) => ({ title, description, prompt, glyph })) }

  it('generates on Claude Code with --effort low and --json-schema, never needing a key', async () => {
    const calls: Array<readonly string[]> = []
    const quick = createQuickModel({
      engine: () => 'claude-code',
      apiKey: () => null,
      client: () => {
        throw new Error('no key path on Claude Code')
      },
      others: {
        'claude-code': claudeQuickEngine({
          ready: async () => ({ ok: true }),
          run: async (args) => {
            calls.push(args)
            return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: okStarters }), stderr: '' }
          },
        }),
      },
    })
    expect(await generateStarters(quick, context)).toHaveLength(5)
    const args = calls[0] ?? []
    expect(args[args.indexOf('--effort') + 1]).toBe('low')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '{}')).toMatchObject({ type: 'object' })
    expect(args[args.indexOf('--model') + 1]).toBe(STARTER_MODEL)
  })
})
