/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent, ToolKind } from '@shared/ipc'

// The tool event fields, filled the same way by every engine: what kind of
// step it is (the plain-word status and the fold's grouping read it), when it
// ran, and short summaries of its input and result for the expanded trace.

/** Summaries are capped at 2 KB. */
export const TOOL_SUMMARY_MAX = 2048

export type ToolEvent = Extract<AgentEvent, { type: 'tool' }>

const KINDS: Record<string, ToolKind> = {
  read_page: 'read-page',
  get_page_text: 'read-page',
  find: 'find',
  screenshot: 'screenshot',
  zoom: 'screenshot',
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  hover: 'click',
  mouse_move: 'click',
  left_click_drag: 'click',
  left_mouse_down: 'click',
  left_mouse_up: 'click',
  scroll: 'click',
  scroll_to: 'click',
  type: 'type',
  key: 'type',
  hold_key: 'type',
  form_input: 'type',
  navigate: 'navigate',
  new_tab: 'tabs',
  list_tabs: 'tabs',
  switch_tab: 'tabs',
  close_tab: 'tabs',
  web_search: 'web-search',
  WebSearch: 'web-search',
  web_fetch: 'web-fetch',
  memory: 'memory',
}

/** The kind of a tool by its member name (unqualified); a connector's tools are 'connector'. */
export function toolKind(name: string, connector = false): ToolKind {
  if (connector) return 'connector'
  return KINDS[name] ?? 'other'
}

export function clip(text: string, max = TOOL_SUMMARY_MAX): string {
  const clean = text.replace(/\s+\n/g, '\n').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** The input as one short line: a single text field as is, otherwise compact JSON. */
export function summarizeInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'string') return clip(input) || undefined
  if (typeof input !== 'object') return clip(String(input))
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null)
  if (entries.length === 0) return undefined
  try {
    return clip(JSON.stringify(Object.fromEntries(entries)))
  } catch {
    return undefined
  }
}

/** A tool result's text, with images and page state named rather than dumped. */
export function summarizeResult(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined
  if (typeof content === 'string') return clip(content) || undefined
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[screenshot]')
    else if (block?.type === 'browser_state') parts.push('[tabs and page state]')
  }
  return parts.length > 0 ? clip(parts.join('\n')) || undefined : undefined
}

/** A server tool's result block, summed up: how many search results, or the fetched page's title. */
export function summarizeServerResult(block: { type?: string; content?: unknown } | undefined): string | undefined {
  if (!block) return undefined
  const content = block.content as unknown
  if (Array.isArray(content)) return content.length === 1 ? '1 result' : `${content.length} results`
  if (content && typeof content === 'object') {
    const c = content as { type?: string; error_code?: string; url?: string; content?: { title?: string } }
    if (c.error_code) return clip(`Error: ${c.error_code}`)
    if (c.content?.title) return clip(c.content.title)
    if (c.url) return clip(c.url)
  }
  return undefined
}

/**
 * Tracks the steps of one run, so every running step gets its end (and a
 * stopped run's server steps don't keep spinning).
 */
export class ToolTracker {
  readonly #running = new Map<string, ToolEvent>()

  start(event: Omit<ToolEvent, 'type' | 'state' | 'startedAt'> & { startedAt?: number }): ToolEvent {
    const started: ToolEvent = { type: 'tool', state: 'running', startedAt: event.startedAt ?? Date.now(), ...stripUndefined(event) }
    this.#running.set(started.id, started)
    return started
  }

  finish(id: string, outcome: { ok: boolean; detail?: string; result?: string }, fallback?: Omit<ToolEvent, 'type' | 'state'>): ToolEvent {
    const base = this.#running.get(id) ?? (fallback ? { type: 'tool' as const, state: 'running' as const, ...fallback } : { type: 'tool' as const, id, label: 'Tool', state: 'running' as const })
    this.#running.delete(id)
    return {
      ...base,
      state: outcome.ok ? 'done' : 'error',
      endedAt: Date.now(),
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      ...(outcome.result ? { result: outcome.result } : {}),
    }
  }

  isRunning(id: string): boolean {
    return this.#running.has(id)
  }

  /** Ends every step still running (the run stopped or failed). */
  settle(detail: string): ToolEvent[] {
    const out = [...this.#running.keys()].map((id) => this.finish(id, { ok: false, detail }))
    return out
  }
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
