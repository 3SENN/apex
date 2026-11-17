/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { NOT_EXECUTED, STOPPED, describeToolCall, runToolCalls, type ToolHandler } from '../src/main/agent/browserTool'
import { memberSchemas } from '../src/main/agent/schemas'

const ok: ToolHandler = { execute: async (name) => [{ type: 'text', text: `ran ${name}` }] }
const call = (id: string, name: string, input: unknown = {}, toolset_name: string | null = 'browser') => ({ id, name, input, toolset_name })

describe('runToolCalls', () => {
  it('runs calls in order and echoes toolset_name', async () => {
    const results = await runToolCalls([call('1', 'screenshot'), call('2', 'read_page')], { browser: ok }, new AbortController().signal)
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: '1', toolset_name: 'browser', content: [{ type: 'text', text: 'ran screenshot' }] },
      { type: 'tool_result', tool_use_id: '2', toolset_name: 'browser', content: [{ type: 'text', text: 'ran read_page' }] },
    ])
  })

  it('halts the batch after the first failure', async () => {
    const failing: ToolHandler = {
      execute: async (name) => {
        if (name === 'left_click') throw new Error('ref_3 is stale or not found on the current page.')
        return [{ type: 'text', text: name }]
      },
    }
    const results = await runToolCalls([call('1', 'read_page'), call('2', 'left_click'), call('3', 'screenshot')], { browser: failing }, new AbortController().signal)
    expect(results[0]?.is_error).toBeUndefined()
    expect(results[1]).toMatchObject({ is_error: true, toolset_name: 'browser', content: 'Error: ref_3 is stale or not found on the current page.' })
    expect(results[2]).toMatchObject({ is_error: true, toolset_name: 'browser', content: NOT_EXECUTED })
  })

  it('answers every call after the user stops the agent', async () => {
    const controller = new AbortController()
    const stopping: ToolHandler = {
      execute: async () => {
        controller.abort()
        throw new Error('aborted')
      },
    }
    const results = await runToolCalls([call('1', 'wait'), call('2', 'screenshot')], { browser: stopping }, controller.signal)
    expect(results.map((r) => r.content)).toEqual([STOPPED, STOPPED])
  })

  it('routes plain client tools by name and never echoes toolset_name on them', async () => {
    const memory: ToolHandler = { execute: async () => 'File created successfully at: /memories/a.md' }
    const [saved, unknown] = await runToolCalls([call('1', 'memory', {}, null), call('2', 'calculator', {}, null)], { browser: ok, client: { memory } }, new AbortController().signal)
    expect(saved).toEqual({ type: 'tool_result', tool_use_id: '1', content: 'File created successfully at: /memories/a.md' })
    expect(unknown).not.toHaveProperty('toolset_name')
    expect(unknown?.is_error).toBe(true)
  })
})

describe('member schemas', () => {
  it('accept the documented input shapes', () => {
    expect(memberSchemas.left_click.safeParse({ target: { type: 'ref', ref: 'ref_2' } }).success).toBe(true)
    expect(memberSchemas.left_click.safeParse({ target: { type: 'coordinate', x: 10, y: 20 }, modifiers: 'shift' }).success).toBe(true)
    expect(memberSchemas.scroll.safeParse({ target: { type: 'coordinate', x: 1, y: 1 }, scroll_direction: 'down', scroll_amount: 3 }).success).toBe(true)
    expect(memberSchemas.form_input.safeParse({ target: { type: 'ref', ref: 'ref_1' }, value: true }).success).toBe(true)
    expect(memberSchemas.read_page.safeParse({ filter: 'interactive', depth: 5 }).success).toBe(true)
  })

  it('reject malformed inputs', () => {
    expect(memberSchemas.left_click.safeParse({ target: { type: 'ref' } }).success).toBe(false)
    expect(memberSchemas.scroll.safeParse({ target: { type: 'ref', ref: 'ref_1' }, scroll_direction: 'down' }).success).toBe(false)
    expect(memberSchemas.scroll.safeParse({ target: { type: 'coordinate', x: 1, y: 1 }, scroll_direction: 'down', scroll_amount: 11 }).success).toBe(false)
    expect(memberSchemas.wait.safeParse({ duration: 31 }).success).toBe(false)
    expect(memberSchemas.zoom.safeParse({ region: [0, 0, 10] }).success).toBe(false)
    expect(memberSchemas.switch_tab.safeParse({}).success).toBe(false)
  })

  it('leave the optional members disabled', () => {
    for (const name of ['javascript_exec', 'file_upload', 'read_console', 'read_network']) {
      expect(Object.hasOwn(memberSchemas, name)).toBe(false)
    }
  })
})

describe('describeToolCall', () => {
  it('labels calls for the agent panel', () => {
    expect(describeToolCall('navigate', { url: 'back' })).toBe('Go back')
    expect(describeToolCall('left_click', { target: { type: 'ref', ref: 'ref_4' } })).toBe('Click ref_4')
    expect(describeToolCall('left_click', { target: { type: 'coordinate', x: 5, y: 9 } })).toBe('Click (5, 9)')
    expect(describeToolCall('type', { text: 'hello' })).toBe('Type "hello"')
  })
})
