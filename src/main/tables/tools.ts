/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The tables client tools (list_tables, query_table, write_table).
// Reads run on a separate read-only connection in a worker; every write
// shows its statement and scope on a table-write card first (CH-43). "For
// this chat" covers later non-destructive writes only: DELETE, DROP, ALTER,
// REPLACE and an UPDATE without WHERE always ask again.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AgentRequestResponse } from '@shared/agentTools'
import { isFlagOn } from '@shared/flags'
import { SHARED_OWNER } from '@shared/chats'
import { CLIENT_TOOL_RESULT_MAX, registerClientTool, type ClientTool, type ClientToolResult } from '../agent/tools/registry'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import type { ReadRunner } from './queryClient'
import { formatRead } from './query'
import { checkRead, classifySql } from './sqlGuard'
import type { TableStore } from './store'

export interface TableToolDeps {
  store: TableStore
  read: ReadRunner
  changed(): void
}

type WriteScope = 'companion' | 'shared'

const err = (content: string): ClientToolResult => ({ content, isError: true })

/** Chats that allowed non-destructive writes for the rest of the chat, by scope. */
const chatGrants = new Map<string, Set<WriteScope>>()

export function resetTableGrantsForTests(): void {
  chatGrants.clear()
}

function scopeOwner(scope: WriteScope, companionId: string): string {
  return scope === 'shared' ? SHARED_OWNER : companionId
}

export function registerTableTools(deps: TableToolDeps): void {
  const { store } = deps

  registerClientTool({
    name: 'list_tables',
    group: 'tables',
    description:
      `Lists the local tables you can query: your own, and the shared ones (query those as shared.<name>). Each comes with its columns, their types and its row count. Tables are CSV files the person imported into ${BRAND_NAME}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    parse: z.object({}).strict(),
    enabled: (setup) => setup.workspace.tables && isFlagOn(setup.flags, 'tables'),
    async run(_input, ctx) {
      const own = ctx.companionId === SHARED_OWNER ? [] : store.list(ctx.companionId)
      const shared = store.list(SHARED_OWNER)
      const describe = (prefix: string) => (t: ReturnType<TableStore['list']>[number]) => ({ table: `${prefix}${t.name}`, rows: t.rowCount, columns: t.columns })
      const tables = [...own.map(describe('')), ...shared.map(describe(ctx.companionId === SHARED_OWNER ? '' : 'shared.'))]
      if (tables.length === 0) return { content: JSON.stringify({ tables: [], note: 'No tables yet. The person can import a CSV file in Workspace › Tables.' }) }
      return { content: JSON.stringify({ tables }).slice(0, CLIENT_TOOL_RESULT_MAX) }
    },
  })

  registerClientTool({
    name: 'query_table',
    group: 'tables',
    description:
      'Runs one read-only SQL statement (SELECT or WITH, SQLite dialect) on the local tables and returns JSON rows: at most 500 rows and 50,000 characters, so aggregate or filter in SQL. Shared tables are shared.<name>. ATTACH, PRAGMA and writes are refused.',
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'One SELECT or WITH statement.' } },
      required: ['sql'],
      additionalProperties: false,
    },
    parse: z.object({ sql: z.string().min(1).max(100_000) }).strict(),
    enabled: (setup) => setup.workspace.tables && isFlagOn(setup.flags, 'tables'),
    async run(input, ctx) {
      const check = checkRead(input.sql)
      if (!check.ok) return err(check.reason)
      const result = await deps.read(
        { dbPath: store.pathOf(ctx.companionId), sharedPath: ctx.companionId === SHARED_OWNER ? null : store.pathOf(SHARED_OWNER), statement: check.statement },
        ctx.signal,
      )
      if (!result.ok) return err(result.error)
      return { content: formatRead(result) }
    },
  } satisfies ClientTool<{ sql: string }>)

  registerClientTool({
    name: 'write_table',
    group: 'tables',
    description:
      'Changes local tables with one SQL statement (INSERT, UPDATE, DELETE, REPLACE, CREATE TABLE, ALTER TABLE or DROP TABLE; SQLite dialect). The person sees the statement first and decides; destructive changes always ask. scope "companion" (default) writes your own tables, "shared" the shared ones; name tables without a schema prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One statement that changes data or tables.' },
        scope: { type: 'string', enum: ['companion', 'shared'], description: 'Whose tables: your own (default) or the shared ones.' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    parse: z.object({ sql: z.string().min(1).max(100_000), scope: z.enum(['companion', 'shared']).optional() }).strict(),
    // It waits on the person, so never in routines; and only while table writes are on.
    enabled: (setup) => setup.workspace.tables && !setup.routine && isFlagOn(setup.flags, 'tables-agent-writes'),
    async run(input, ctx) {
      const verdict = classifySql(input.sql)
      if (!verdict.ok) return err(verdict.reason)
      if (verdict.kind !== 'write') return err('write_table only changes tables; use query_table to read.')
      if (/\bshared\s*\./i.test(verdict.statement)) return err('Name tables without the shared. prefix and set scope to "shared" instead.')
      const scope: WriteScope = input.scope ?? 'companion'
      const owner = scopeOwner(scope, ctx.companionId)
      const granted = !verdict.destructive && chatGrants.get(ctx.chatId)?.has(scope) === true
      if (!granted) {
        const answer = await ctx.ask<Extract<AgentRequestResponse, { kind: 'table-write' }>>({
          type: 'table-write',
          requestId: randomUUID(),
          table: verdict.table ?? '',
          sql: verdict.statement,
          scope: scope === 'shared' ? mainT('platform.tables.scope.shared') : mainT('platform.tables.scope.companion'),
          destructive: verdict.destructive,
        })
        if (answer?.kind !== 'table-write' || !answer.allowed) return err('The person declined this change, so the tables are unchanged.')
        if (answer.scope === 'chat' && !verdict.destructive) {
          const set = chatGrants.get(ctx.chatId) ?? new Set<WriteScope>()
          set.add(scope)
          chatGrants.set(ctx.chatId, set)
        }
      }
      try {
        const db = store.db(owner)
        const result = db.prepare(verdict.statement).run()
        store.reconcile(owner)
        store.touch(owner, verdict.table)
        deps.changed()
        log.info('tables', `write_table ran on ${scope} tables`, { destructive: verdict.destructive })
        return { content: JSON.stringify({ ok: true, changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }) }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e))
      }
    },
  } satisfies ClientTool<{ sql: string; scope?: WriteScope }>)
}
