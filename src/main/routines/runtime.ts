/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the skills and routines feature needs from index.ts (AppContext.skillRoutines):
// the skill and routine stores and runner, plus the chat and companion
// stores that Save as skill, routine destinations and suggestions read.
import type { BrowserWindow } from 'electron'
import type { ChatSummary } from '@shared/chats'
import type { SiteInsight } from '@shared/timeline'
import type { AgentEvent } from '@shared/ipc'
import type { RoutineRunner } from '../routines'
import type { SkillStore } from '../skills/store'
import type { RoutineStore } from './store'

export interface SkillRoutineRuntime {
  skills: SkillStore
  routines: RoutineStore
  runner: RoutineRunner
  chats: {
    list(): ChatSummary[]
    summary(id: string): ChatSummary | undefined
    load(id: string): { log: AgentEvent[] }
    update(ids: readonly string[], patch: Partial<Pick<ChatSummary, 'routineRun'>>): unknown
    on(event: 'changed', listener: (items: ChatSummary[]) => void): unknown
  }
  companions: {
    find(id: string): { id: string; name: string } | undefined
    get(): { id: string; name: string }
  }
  /** The window dialogs attach to. */
  window(): BrowserWindow | null
  /** The activity timeline, for morning-site suggestions; absent until it is wired. */
  timeline?: { sites(q: { from: number; to: number; sort?: 'time' | 'visits' | 'recent' }): SiteInsight[] }
  /** Reveals a folder in Finder (shell.showItemInFolder). */
  reveal?(path: string): void
}
