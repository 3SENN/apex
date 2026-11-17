/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { memoryLocation, SHARED_OWNER } from '@shared/chats'
import type { AgentEvent, MemoryChange } from '@shared/ipc'

// CH-27's event sources: what a turn did, as events the chat draws as cards.
// Memory commands become saved/updated/forgotten/renamed changes, browser
// results that opened a tab become 'tab-opened', and a reply that ended
// early is marked 'partial' with its reason.

const memoryCommand = z.discriminatedUnion('command', [
  z.object({ command: z.literal('view'), path: z.string() }).passthrough(),
  z.object({ command: z.literal('create'), path: z.string() }).passthrough(),
  z.object({ command: z.literal('str_replace'), path: z.string() }).passthrough(),
  z.object({ command: z.literal('insert'), path: z.string() }).passthrough(),
  z.object({ command: z.literal('delete'), path: z.string() }).passthrough(),
  z.object({ command: z.literal('rename'), old_path: z.string(), new_path: z.string() }).passthrough(),
])

/**
 * The change a successful memory command made. `companionId` is null for
 * chats from before companions had their own memory, where /memories is the
 * shared folder.
 */
export function memoryChanges(input: unknown, companionId: string | null): MemoryChange[] {
  const parsed = memoryCommand.safeParse(input)
  if (!parsed.success) return []
  const command = parsed.data
  const where = (path: string): { owner: string; path: string } => (companionId ? memoryLocation(path, companionId) : { owner: SHARED_OWNER, path })
  switch (command.command) {
    case 'view':
      return []
    case 'create':
      return [{ op: 'saved', ...where(command.path) }]
    case 'str_replace':
    case 'insert':
      return [{ op: 'updated', ...where(command.path) }]
    case 'delete':
      return [{ op: 'forgotten', ...where(command.path) }]
    case 'rename': {
      const from = where(command.old_path)
      return [{ op: 'renamed', ...from, to: where(command.new_path).path }]
    }
  }
}

/** The memory-change event for one command, or null when it changed nothing. */
export function memoryChangeEvent(turnId: string, input: unknown, companionId: string | null): AgentEvent | null {
  const changes = memoryChanges(input, companionId)
  return changes.length > 0 ? { type: 'memory-change', turnId, changes } : null
}

/** Tab ids a browser tool result reports as newly opened (browser_state.state_changes tab_opened). */
export function openedTabIds(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content as Array<{ type?: string; state_changes?: Array<{ type?: string; tab_id?: string }> | null }>) {
    if (block?.type !== 'browser_state') continue
    for (const change of block.state_changes ?? []) if (change?.type === 'tab_opened' && typeof change.tab_id === 'string' && !ids.includes(change.tab_id)) ids.push(change.tab_id)
  }
  return ids
}

export type PartialReason = Extract<AgentEvent, { type: 'partial' }>['reason']

/**
 * Why a run's reply ended early, or null when it finished. A stop or an
 * error counts only once the reply had some output; the step cap and a
 * cut-off always do.
 */
export function partialReason(end: { stepLimit: boolean; cutOff: boolean; stopped: boolean; error: boolean; hadOutput: boolean }): PartialReason | null {
  if (end.stepLimit) return 'step-limit'
  if (end.cutOff) return 'cut-off'
  if (end.stopped) return end.hadOutput ? 'stopped' : null
  if (end.error) return end.hadOutput ? 'error' : null
  return null
}
