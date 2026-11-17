/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DelegationStatus, PlanItem, UserMessageSkill } from '@shared/agentTools'
import type { MessageDetails, TurnUsage } from '@shared/chats'
import { engineHasOwnAccount } from '@shared/engine'
import type { LibraryFileRef, ViewerTarget } from '@shared/files'
import type { FileRef } from '@shared/workspace'
import type { LogItem } from '../../agentLog'

// The chat details panel's section model (CH-35, DS-123, DS-124): a pure fold
// of the chat's log and setup into the sections it lists, in DS-124's order.
// DetailsPanel.tsx draws it; the rules (order, counts, collapse defaults,
// opening once by itself) are tested here.

export type DetailsSectionId = 'companion' | 'plan' | 'connectors' | 'skills' | 'files' | 'context' | 'subtasks' | 'sources' | 'usage'

/** DS-124's order, with the plan first after the companion (it is what the agent is doing now). */
export const DETAILS_SECTION_ORDER: readonly DetailsSectionId[] = ['companion', 'plan', 'connectors', 'skills', 'files', 'context', 'subtasks', 'sources', 'usage']

/** Files and tokens start collapsed (DS-124); everything else open. */
export const COLLAPSED_BY_DEFAULT: ReadonlySet<DetailsSectionId> = new Set<DetailsSectionId>(['files', 'usage'])

export type DetailsFile =
  | { kind: 'library'; id: string; name: string; file: LibraryFileRef }
  | { kind: 'written'; id: string; name: string; ref: FileRef }

export interface DetailsSubtask {
  id: string
  childChatId: string
  title: string
  status: DelegationStatus
}

export interface DetailsModel {
  plan: PlanItem[]
  planDone: number
  files: DetailsFile[]
  sources: Array<{ url: string; title: string }>
  skills: UserMessageSkill[]
  connectors: Array<{ id: string; name: string }>
  subtasks: DetailsSubtask[]
  /** Summed from the turns' details; the usage service's totals win where present. */
  tokens: TurnUsage & { turns: number }
  routineId: string | null
  usedTabCount: number
}

export interface DetailsInput {
  items: readonly LogItem[]
  details: Record<string, MessageDetails>
  connectorIds: readonly string[]
  /** Connector names by id; unknown ids keep their id. */
  connectorNames: Record<string, string>
  routineId: string | null
  usedTabIds: readonly string[]
}

export function detailsModel(input: DetailsInput): DetailsModel {
  let plan: PlanItem[] = []
  const files = new Map<string, DetailsFile>()
  const sources = new Map<string, { url: string; title: string }>()
  const skills = new Map<string, UserMessageSkill>()
  const subtasks = new Map<string, DetailsSubtask>()
  for (const item of input.items) {
    switch (item.kind) {
      case 'plan':
        plan = item.items
        break
      case 'file-produced':
        // Failed reports never made a file.
        if (item.file.state !== 'failed') files.set(`library:${item.file.id}`, { kind: 'library', id: item.file.id, name: item.file.name, file: item.file })
        else files.delete(`library:${item.file.id}`)
        break
      case 'file-written':
        files.set(item.id, { kind: 'written', id: item.id, name: item.name, ref: item.ref })
        break
      case 'source':
        sources.set(item.url, { url: item.url, title: item.title })
        break
      case 'user':
        if (item.skill) skills.set(item.skill.id, item.skill)
        break
      case 'delegation':
        subtasks.set(item.id, { id: item.id, childChatId: item.childChatId, title: item.title, status: item.status })
        break
      default:
        break
    }
  }
  const tokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 }
  for (const d of Object.values(input.details)) {
    tokens.inputTokens += d.usage.inputTokens
    tokens.outputTokens += d.usage.outputTokens
    tokens.cacheReadTokens += d.usage.cacheReadTokens
    tokens.cacheWriteTokens += d.usage.cacheWriteTokens
    tokens.turns++
  }
  return {
    plan,
    planDone: plan.filter((p) => p.status === 'done' || p.status === 'skipped').length,
    files: [...files.values()],
    sources: [...sources.values()],
    skills: [...skills.values()],
    connectors: input.connectorIds.map((id) => ({ id, name: input.connectorNames[id] ?? id })),
    subtasks: [...subtasks.values()],
    tokens,
    routineId: input.routineId,
    usedTabCount: input.usedTabIds.length,
  }
}

/** The sections worth drawing: the companion and tokens always, the rest only with something in them. `heldFiles` is what the chat holds (CH-28; DS-49 moved its button here), so files show for it too. */
export function visibleSections(model: DetailsModel, heldFiles = 0): DetailsSectionId[] {
  return DETAILS_SECTION_ORDER.filter((id) => {
    switch (id) {
      case 'companion':
      case 'usage':
        return true
      case 'plan':
        return model.plan.length > 0
      case 'connectors':
        return model.connectors.length > 0
      case 'skills':
        return model.skills.length > 0
      case 'files':
        return model.files.length > 0 || heldFiles > 0
      case 'context':
        return model.routineId !== null || model.usedTabCount > 0
      case 'subtasks':
        return model.subtasks.length > 0
      case 'sources':
        return model.sources.length > 0
    }
  })
}

/** The count a section header shows inline, or null. */
export function sectionCount(model: DetailsModel, id: DetailsSectionId, heldFiles = 0): number | null {
  switch (id) {
    case 'plan':
      return model.plan.length
    case 'connectors':
      return model.connectors.length
    case 'skills':
      return model.skills.length
    case 'files':
      return Math.max(model.files.length, heldFiles)
    case 'subtasks':
      return model.subtasks.length
    case 'sources':
      return model.sources.length
    default:
      return null
  }
}

/** Whether a section is collapsed: what you chose, else the default. */
export function isCollapsed(id: DetailsSectionId, remembered: Partial<Record<DetailsSectionId, boolean>>): boolean {
  return remembered[id] ?? COLLAPSED_BY_DEFAULT.has(id)
}

/**
 * The panel opens by itself once per chat (CH-35): when the first plan or
 * produced file appears, unless you already opened or closed it for this chat.
 */
export function shouldAutoOpen(items: readonly LogItem[], alreadyDecided: boolean): boolean {
  if (alreadyDecided) return false
  return items.some((item) => item.kind === 'plan' || (item.kind === 'file-produced' && item.file.state !== 'failed') || item.kind === 'file-written')
}

/** Below this window width the panel overlays the chat instead of taking a column. */
export const DETAILS_OVERLAY_BELOW = 980
/** The column's width (DS-123: 305 px). */
export const DETAILS_WIDTH = 305

export function detailsMode(windowWidth: number): 'column' | 'overlay' {
  return windowWidth < DETAILS_OVERLAY_BELOW ? 'overlay' : 'column'
}

/** A sub-task's status as a tone for its pill. */
export function delegationTone(status: DelegationStatus): 'working' | 'success' | 'needs-input' | 'error' | 'idle' {
  switch (status) {
    case 'working':
      return 'working'
    case 'done':
      return 'success'
    case 'needs-input':
      return 'needs-input'
    case 'needs-attention':
      return 'error'
    case 'stopped':
    case 'interrupted':
      return 'idle'
  }
}

/** Stopped and interrupted sub-tasks can be continued (CH-32). */
export const canContinue = (status: DelegationStatus): boolean => status === 'stopped' || status === 'interrupted'

/** Where a file row opens: the viewer for the files it can show, null for folder and app files (they open in Workspace). */
export function viewerTargetFor(file: DetailsFile): ViewerTarget | null {
  if (file.kind === 'library') return { kind: 'library', id: file.file.id }
  const ref = file.ref
  switch (ref.kind) {
    case 'library':
      return { kind: 'library', id: ref.id }
    case 'companion':
      return { kind: 'companion-file', companionId: ref.companionId, path: ref.path }
    case 'memory':
      return { kind: 'memory', owner: ref.owner, path: ref.path }
    case 'skill':
      return { kind: 'skill', skillId: ref.skillId }
    case 'folder':
    case 'app':
      return null
  }
}

/** The usage section's rows: the usage service's totals when it answered, else the sum of the turns' details. */
export function usageRows(model: DetailsModel, totals: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; approxCostUsd: number | null } | null): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
  costUsd: number | null
  total: number
} {
  const src = totals ?? { ...model.tokens, approxCostUsd: null }
  return {
    input: src.inputTokens,
    output: src.outputTokens,
    cacheRead: src.cacheReadTokens,
    cacheWrite: src.cacheWriteTokens,
    turns: src.turns,
    costUsd: totals?.approxCostUsd ?? null,
    total: src.inputTokens + src.outputTokens + src.cacheReadTokens + src.cacheWriteTokens,
  }
}

// ── DS-123: the slot below the details card ──

/** What the slot below the card offers: a 32 px action pill and a two-line caption. Never an upsell. */
export type DetailsPrompt =
  | { kind: 'api-key'; url: string }
  | { kind: 'budget'; url: string; usd: number; budgetUsd: number }

/** How much of your own monthly budget makes the slot mention it. */
export const BUDGET_NOTICE_AT = 0.8

/**
 * The slot's prompt, or null: a way to connect when this chat can't reply
 * (no API key, and not on an engine with its own sign-in), else a note once
 * your own monthly budget is mostly used (API key only; other engines have no
 * per-token spend here).
 */
export function detailsPrompt(input: { canSend: boolean; engine: string | undefined; spend: { usd: number; budgetUsd: number | null } | null }): DetailsPrompt | null {
  if (!input.canSend) return { kind: 'api-key', url: 'atelier://settings/model' }
  const spend = input.spend
  if (engineHasOwnAccount(input.engine) || !spend || spend.budgetUsd === null || !(spend.budgetUsd > 0)) return null
  if (spend.usd / spend.budgetUsd < BUDGET_NOTICE_AT) return null
  return { kind: 'budget', url: 'atelier://settings/you', usd: spend.usd, budgetUsd: spend.budgetUsd }
}
