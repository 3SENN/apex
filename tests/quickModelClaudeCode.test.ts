/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createQuickModel, QUICK_DEFAULT_MODEL, type QuickClient, type QuickCreateParams, type QuickModelDeps } from '../src/main/agent/quick'
import { claudeQuickEngine, fitClaudeArgs, parseClaudeResult, quickClaudeArgs } from '../src/engines/claude-code/main/quick'

// QuickModel on Claude Code (src/engines/claude-code/main/quick.ts): the
// one-shot `claude -p` call with every tool and setting off. The engine-neutral
// parts are tests/quickModel.test.ts.

/** A scripted Messages client: answers each call with the next reply and records the request. */
function scripted(replies: string[]) {
  const requests: QuickCreateParams[] = []
  const client: QuickClient = {
    messages: {
      create: async (params) => {
        requests.push(params)
        const text = replies.shift() ?? ''
        return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
      },
    },
  }
  return { client, requests }
}

function deps(over: Partial<QuickModelDeps> = {}): QuickModelDeps {
  return { engine: () => 'api-key', apiKey: () => 'sk-test', client: () => scripted([]).client, others: {}, ...over }
}

describe('QuickModel on Claude Code', () => {
  const schema = z.object({ title: z.string(), items: z.array(z.string()) })
  type Run = Parameters<typeof claudeQuickEngine>[0]['run']
  const claude = (run: Run, ready = true): QuickModelDeps['others'] => ({ 'claude-code': claudeQuickEngine({ ready: async () => ({ ok: ready }), run }) })
  const result = (body: Record<string, unknown>): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, ...body }), stderr: '' })

  it('runs Claude Code one-shot with tools off when that engine is chosen', async () => {
    const calls: Array<{ args: readonly string[]; input: string }> = []
    const quick = createQuickModel(deps({ engine: () => 'claude-code', others: claude(async (args, input) => (calls.push({ args, input }), result({ result: 'From Claude Code.' }))) }))
    expect(await quick.text({ system: 'sys', prompt: 'the prompt' })).toBe('From Claude Code.')
    expect(calls[0]?.input).toBe('the prompt')
    const args = calls[0]?.args ?? []
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(await quick.ready()).toEqual({ ok: true, engine: 'claude-code' })
  })

  it('falls back to the key when Claude Code is not ready', async () => {
    const s = scripted(['via key'])
    const quick = createQuickModel(deps({ engine: () => 'claude-code', client: () => s.client, others: claude(async () => ({ code: 1, stdout: '', stderr: '' }), false) }))
    expect(await quick.text({ system: 's', prompt: 'p' })).toBe('via key')
  })

  it('passes --effort and --json-schema to Claude Code and reads structured_output', async () => {
    const calls: Array<readonly string[]> = []
    const quick = createQuickModel(deps({ engine: () => 'claude-code', apiKey: () => null, others: claude(async (args) => (calls.push(args), result({ result: '', structured_output: { title: 'T', items: [] } }))) }))
    expect(await quick.json({ system: 's', prompt: 'p', schema, effort: 'medium' })).toEqual({ title: 'T', items: [] })
    const args = calls[0] ?? []
    expect(args[args.indexOf('--effort') + 1]).toBe('medium')
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] ?? 'null')).toMatchObject({ type: 'object', required: ['title', 'items'] })
    expect(args).toContain('--no-session-persistence')
  })

  it('runs Claude Code once more without the new flags when the CLI refuses them before any model call', async () => {
    const calls: Array<readonly string[]> = []
    const quick = createQuickModel(
      deps({
        engine: () => 'claude-code',
        apiKey: () => null,
        others: claude(async (args) => {
          calls.push(args)
          if (args.includes('--json-schema')) return { code: 1, stdout: '', stderr: "error: unknown option '--json-schema'" }
          return result({ result: '{"title":"T","items":["x"]}' })
        }),
      }),
    )
    expect(await quick.json({ system: 's', prompt: 'p', schema, effort: 'low' })).toEqual({ title: 'T', items: ['x'] })
    expect(calls).toHaveLength(2)
    expect(calls[1]).not.toContain('--effort')
    // A real model error (is_error on stdout) is not retried.
    const failing = createQuickModel(deps({ engine: () => 'claude-code', apiKey: () => null, others: claude(async () => ({ code: 1, stdout: '{"result":"Not logged in","is_error":true}', stderr: '' })) }))
    await expect(failing.text({ system: 's', prompt: 'p', effort: 'low' })).rejects.toThrow('Not logged in')
  })

  it('runs the tools on Claude Code too, one run per round in JSON, with the same history', async () => {
    const prompts: string[] = []
    const answers = [{ action: 'tool', tool: 'lookup', input: { q: 'ghosts' } }, { action: 'reply', text: 'You have one story about ghosts.' }]
    const cc = createQuickModel(deps({ engine: () => 'claude-code', apiKey: () => null, others: claude(async (_args, input) => (prompts.push(input), result({ structured_output: answers.shift() }))) }))
    const calls: unknown[] = []
    const out = await cc.toolLoop({
      system: 's',
      history: [{ role: 'user', content: 'Any ghost stories?' }],
      tools: [{ name: 'lookup', description: 'Finds stories.', input_schema: { type: 'object' } }],
      onTool: async (name, input) => (calls.push([name, input]), { ok: true, text: '["Ghosts"]' }),
    })
    expect(out.text).toBe('You have one story about ghosts.')
    expect(calls).toEqual([['lookup', { q: 'ghosts' }]])
    expect(out.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(out.history[1]?.content).toMatchObject([{ type: 'tool_use', name: 'lookup', input: { q: 'ghosts' } }])
    expect(prompts[1]).toContain('The tool returned: ["Ghosts"]')
  })
})

describe('quick helpers for Claude Code', () => {
  it('builds settings-free Claude Code arguments', () => {
    const args = quickClaudeArgs({ system: 'S', model: 'claude-haiku-5-5' })
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('S')
  })

  it('fits Windows’ 32,767-character command line: the system prompt in a file, then a schema left out', () => {
    const files: string[] = []
    const toFile = (text: string): string => {
      files.push(text)
      return 'C:\\Temp\\atelier-claude-1\\system-prompt.txt'
    }
    const small = quickClaudeArgs({ system: 'S', model: 'claude-haiku-5-5', jsonSchema: { type: 'object' } })
    expect(fitClaudeArgs(small, 'win32', toFile)).toEqual(small)
    // A pack's tool loop: an 8,000-character prompt and 20 tools of 2,000 characters each.
    const system = 'x'.repeat(48_000)
    const long = quickClaudeArgs({ system, model: 'claude-haiku-5-5', jsonSchema: { type: 'object' } })
    // macOS takes about 1 MB on a command line: unchanged.
    expect(fitClaudeArgs(long, 'darwin', toFile)).toEqual(long)
    expect(files).toEqual([])
    const fitted = fitClaudeArgs(long, 'win32', toFile)
    expect(fitted).not.toContain('--system-prompt')
    expect(fitted[fitted.indexOf('--system-prompt-file') + 1]).toBe('C:\\Temp\\atelier-claude-1\\system-prompt.txt')
    expect(files).toEqual([system])
    expect(fitted[fitted.indexOf('--json-schema') + 1]).toBe('{"type":"object"}')
    // A schema too big by itself goes too: the prompt and the zod check carry the shape.
    const huge = { type: 'object', description: '"'.repeat(20_000) }
    const both = fitClaudeArgs(quickClaudeArgs({ system, model: 'claude-haiku-5-5', jsonSchema: huge }), 'win32', toFile)
    expect(both).not.toContain('--json-schema')
    expect(both).toContain('--system-prompt-file')
  })

  it('reads Claude Code results and errors', () => {
    expect(parseClaudeResult('{"result":"ok","is_error":false}')).toEqual({ ok: true, text: 'ok' })
    expect(parseClaudeResult('{"result":"Not logged in","is_error":true}')).toEqual({ ok: false, error: 'Not logged in' })
    expect(parseClaudeResult('nope').ok).toBe(false)
  })

  it('builds Claude Code arguments without effort or schema by default', () => {
    const args = quickClaudeArgs({ system: 'S', model: QUICK_DEFAULT_MODEL })
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--json-schema')
    expect(parseClaudeResult('{"result":"x","structured_output":{"a":1}}')).toEqual({ ok: true, text: '{"a":1}' })
  })
})
