/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// search_activity: lets a companion search your
// own activity memory, the pages and hourly notes Atelier kept on this device.
// Offered only while activity memory is on and never in a private chat; the
// chat's add-context switch (CH-21) turns it off for that chat, checked on
// every call so the switch works before and after the first message.
import { BRAND_NAME } from '@shared/branding'
import { z } from 'zod'
import type { ActivityItem } from '@shared/activity'
import { CLIENT_TOOL_RESULT_MAX, clientTool, contributeToolSetup, registerClientTool, type ClientTool } from '../agent/tools/registry'

/** What the tool reads; the feature binds the live manager. */
export interface ActivitySearch {
  offeredTo(chatId: string): boolean
  search(q: { query: string; from?: number; to?: number; limit?: number }): ActivityItem[]
  enabled(): boolean
}

let bound: ActivitySearch | null = null

export function bindActivitySearch(search: ActivitySearch | null): void {
  bound = search
}

/**
 * For ToolSetup.workspace.activity when a chat freezes its tools:
 * activity memory is on and this chat's switch is on. Private chats are
 * refused by the tool itself.
 */
export function activityOffered(chatId: string): boolean {
  try {
    return bound?.offeredTo(chatId) ?? false
  } catch {
    return false
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

const input = z
  .object({
    query: z.string().min(1).max(300),
    from: z.string().regex(DAY).optional(),
    to: z.string().regex(DAY).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict()

type Input = z.infer<typeof input>

function dayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getTime()
}

/** The tool result: matches as JSON, newest first, trimmed to the result cap. */
export function formatResults(items: readonly ActivityItem[]): string {
  const rows = items.map((i) => ({
    kind: i.kind,
    at: new Date(i.at).toISOString(),
    title: i.title,
    url: i.url,
    text: i.text ? i.text.slice(0, 1_500) : undefined,
  }))
  let out = JSON.stringify({ results: rows })
  while (out.length > CLIENT_TOOL_RESULT_MAX && rows.length > 1) {
    rows.pop()
    out = JSON.stringify({ results: rows, truncated: true })
  }
  return out.slice(0, CLIENT_TOOL_RESULT_MAX)
}

export const searchActivityTool: ClientTool<Input> = {
  name: 'search_activity',
  group: 'activity',
  description:
    `Search the person's activity memory: pages they visited in ${BRAND_NAME}, text ${BRAND_NAME} kept from those pages, and hourly notes about what they worked on. ` +
    'Everything stays on their device. Use it when they refer to something they saw or worked on earlier ("that article from Tuesday"). ' +
    'Optional from/to are local dates (YYYY-MM-DD), inclusive.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to look for in titles, addresses, page text and notes.' },
      from: { type: 'string', description: 'First local day to search, YYYY-MM-DD.' },
      to: { type: 'string', description: 'Last local day to search, YYYY-MM-DD.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'At most this many results (default 20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  parse: input,
  enabled: (setup) => setup.workspace.activity && !setup.private,
  async run(args, ctx) {
    if (ctx.isPrivate) return { content: 'Activity memory is not available in a private chat.', isError: true }
    if (!bound || !bound.enabled()) return { content: 'Activity memory is off, so there is nothing to search. The person can turn it on in Settings › Activity memory.' }
    if (!activityOffered(ctx.chatId)) return { content: 'The person turned activity memory off for this chat, so it can’t be searched here. They can turn it back on from the + menu.' }
    const from = args.from ? dayStart(args.from) : undefined
    const to = args.to ? dayStart(args.to) + 86_399_999 : undefined
    const items = bound.search({ query: args.query, from, to, limit: args.limit ?? 20 })
    if (items.length === 0) return { content: JSON.stringify({ results: [], note: 'Nothing in activity memory matched.' }) }
    return { content: formatResults(items) }
  },
}

let contributed = false

/** Registers search_activity once (the registry refuses a second registration), and tells new chats whether activity memory is on. */
export function registerSearchActivity(): void {
  if (!clientTool(searchActivityTool.name)) registerClientTool(searchActivityTool)
  if (contributed) return
  contributed = true
  // Private chats are switched off by the registry itself.
  contributeToolSetup(() => ({ activity: bound?.enabled() ?? false }))
}
