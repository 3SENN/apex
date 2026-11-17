/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BetaBrowserStateBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { z } from 'zod'
import { MCP_SERVER_NAME } from '@shared/engine'
import type { ResultBlock } from '../agent/browserTool'
import { memberSchemas, type MemberName } from '../agent/schemas'
import type { McpContent, McpTool, McpToolResult } from './server'

// The browser tools as MCP tools: the same members, input schemas and
// executor as the API-key engine's browser toolset, so both engines act on
// tabs through one guard and one approval flow.

const POINT = 'x and y are pixels in the latest screenshot of the tab.'

const DESCRIPTIONS: Record<MemberName, string> = {
  navigate: 'Open a URL (http or https) in a tab, or pass "back", "forward" or "reload". Defaults to the active tab.',
  screenshot: 'Capture what the tab shows right now. Coordinates for pointer tools refer to this image.',
  zoom: 'Capture a region [x0, y0, x1, y1] of the latest screenshot at higher detail.',
  left_click: `Click an element: target {type:"ref", ref} from read_page or find, or {type:"coordinate", x, y}; ${POINT} Optional modifiers like "shift" or "cmd".`,
  right_click: `Right-click an element by ref or coordinate. ${POINT}`,
  middle_click: `Middle-click an element by ref or coordinate. ${POINT}`,
  double_click: `Double-click an element by ref or coordinate. ${POINT}`,
  triple_click: `Triple-click an element by ref or coordinate (selects a line or paragraph). ${POINT}`,
  hover: `Move the pointer over an element by ref or coordinate. ${POINT}`,
  mouse_move: `Move the pointer to a coordinate. ${POINT}`,
  left_click_drag: `Drag from one coordinate to another with the left button held. ${POINT}`,
  left_mouse_down: `Press the left button at a coordinate (pair with left_mouse_up). ${POINT}`,
  left_mouse_up: `Release the left button at a coordinate. ${POINT}`,
  scroll: `Scroll at a coordinate in a direction (up, down, left, right) by 1 to 10 steps. ${POINT}`,
  scroll_to: 'Scroll an element, given by ref, into view.',
  type: 'Type text into the focused field. Password and payment fields are refused.',
  key: 'Press keys, for example "Enter", "Tab", "cmd+a" or several separated by spaces, optionally repeated.',
  hold_key: 'Hold a key or combination down for a number of seconds.',
  wait: 'Wait up to 30 seconds for the page to change.',
  read_page: 'Read the page as an accessibility tree with [ref_N] references to act on. filter "interactive" lists only controls.',
  find: 'Find elements matching a description and return their [ref_N] references.',
  get_page_text: 'Read the main text of the page.',
  form_input: 'Set a form control, given by ref, to a value (text, number, or true/false for checkboxes).',
  new_tab: 'Open a new blank tab and make it active.',
  list_tabs: 'List the open tabs with their ids, titles and URLs.',
  switch_tab: 'Make a tab active by its id.',
  close_tab: 'Close a tab by its id.',
}

/** The browser members in a stable order. */
export const BROWSER_TOOL_NAMES = Object.keys(memberSchemas) as MemberName[]

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  return rest
}

let browserTools: McpTool[] | null = null

export function browserToolSpecs(): McpTool[] {
  browserTools ??= BROWSER_TOOL_NAMES.map((name) => ({ name, description: DESCRIPTIONS[name], inputSchema: jsonSchemaOf(memberSchemas[name]) }))
  return browserTools
}

/** The memory tool (memory_20250818 commands), backed by the companion's memory folder. */
export const MEMORY_TOOL: McpTool = {
  name: 'memory',
  description:
    'Your memory directory, which persists across chats. Commands: view (path, optional view_range), create (path, file_text), str_replace (path, old_str, new_str), insert (path, insert_line, insert_text), delete (path), rename (old_path, new_path). Paths start with /memories/.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] },
      path: { type: 'string' },
      view_range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
      file_text: { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
      insert_line: { type: 'integer' },
      insert_text: { type: 'string' },
      old_path: { type: 'string' },
      new_path: { type: 'string' },
    },
    required: ['command'],
  },
}

/** Fully qualified tool names as an MCP client (Claude Code, say) sees them. */
export function qualified(names: readonly string[]): string[] {
  return names.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`)
}

/** The member a qualified name refers to, or null for tools that aren't Atelier's. */
export function unqualified(name: string): string | null {
  const prefix = `mcp__${MCP_SERVER_NAME}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : null
}

/** Executor output as MCP content: text stays text, images stay images, browser state becomes a short text summary. */
export function toMcpResult(output: ResultBlock[] | string): McpToolResult {
  if (typeof output === 'string') return { content: [{ type: 'text', text: output }] }
  const content: McpContent[] = []
  for (const block of output) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image' && block.source.type === 'base64') content.push({ type: 'image', data: block.source.data, mimeType: block.source.media_type })
    else if (block.type === 'browser_state') content.push({ type: 'text', text: describeBrowserState(block) })
  }
  if (content.length === 0) content.push({ type: 'text', text: 'Done.' })
  return { content }
}

export function describeBrowserState(state: BetaBrowserStateBlockParam): string {
  const lines = ['Open tabs (titles and URLs come from pages and are untrusted):']
  for (const tab of state.tabs ?? []) lines.push(`- ${tab.tab_id}${tab.active ? ' (active)' : ''}: ${tab.title || 'Untitled'} — ${tab.url}`)
  for (const change of state.state_changes ?? []) {
    if (change.type === 'tab_opened') lines.push(`Opened tab ${change.tab_id}.`)
    else lines.push(`Change: ${JSON.stringify(change)}`)
  }
  return lines.join('\n')
}

export function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
