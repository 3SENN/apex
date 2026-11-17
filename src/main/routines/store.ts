/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The routine records (SK-05 to SK-10) in userData/routines.json. Older
// rows are migrated on load (hours to minutes, the new fields filled in) and
// written back once, with routines.json.bak kept. Run bookkeeping goes
// through `upsert` and never bumps the revision; edits do, so an editor
// saving over a newer version gets 'changed-elsewhere'.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHARED_OWNER } from '@shared/chats'
import { NOTIFY_IF_MAX, ROUTINE_CHANGED_ELSEWHERE, filterRoutines, isPastRoutine, type Routine, type RoutineDestination, type RoutineFilter, type RoutineSaveInput } from '@shared/routines'
import type { Owner } from '@shared/services'
import { writeAtomic } from '../settings'
import { migrateSchedule, nextRunAfter, validateSchedule, type AnySchedule } from './schedule'

export { nextRunAfter, previewSchedule, validateSchedule } from './schedule'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** What the store asks the rest of Atelier; bound by the feature, permissive until then (and in tests). */
export interface RoutineLookups {
  companionExists(id: string): boolean
  /** Why a chat can't take appended runs, or null when it can. */
  chatProblem(chatId: string): 'missing' | 'private' | null
  skillExists(id: string): boolean
}

const OPEN: RoutineLookups = { companionExists: () => true, chatProblem: () => null, skillExists: () => true }

function destinationOf(value: unknown): RoutineDestination {
  return isObject(value) && value.kind === 'append' && str(value.chatId) ? { kind: 'append', chatId: value.chatId } : { kind: 'new-chat' }
}

/** A stored row (older or current shape) as a Routine; `migrated` says the file needs rewriting. */
export function normalizeRoutine(raw: Record<string, unknown>): { routine: Routine; migrated: boolean } {
  const timeZone = str(raw.timeZone) ? raw.timeZone : null
  const { schedule, notice } = migrateSchedule(raw.schedule as AnySchedule, num(raw.nextRunAt), timeZone)
  const migrated = schedule !== raw.schedule || raw.revision === undefined
  const created = num(raw.createdAt) ?? num(raw.lastRunAt) ?? Date.now()
  const routine: Routine = {
    id: String(raw.id),
    name: str(raw.name) ? raw.name : 'Routine',
    prompt: String(raw.prompt ?? ''),
    schedule,
    enabled: raw.enabled === true,
    lastRunAt: num(raw.lastRunAt),
    nextRunAt: num(raw.nextRunAt),
    lastChatId: str(raw.lastChatId) ? raw.lastChatId : null,
    lastStatus: raw.lastStatus === 'ok' || raw.lastStatus === 'error' ? raw.lastStatus : null,
    owner: str(raw.owner) && raw.owner ? raw.owner : SHARED_OWNER,
    timeZone,
    skillId: str(raw.skillId) ? raw.skillId : null,
    destination: destinationOf(raw.destination),
    revision: num(raw.revision) ?? 1,
    createdAt: created,
    updatedAt: num(raw.updatedAt) ?? created,
    needsCompanion: false,
    notice: str(raw.notice) ? raw.notice : notice,
    notifyIf: str(raw.notifyIf) ? raw.notifyIf.trim().slice(0, NOTIFY_IF_MAX) : '',
  }
  return { routine, migrated }
}

function isRow(v: unknown): v is Record<string, unknown> {
  return isObject(v) && str(v.id) && str(v.prompt) && isObject(v.schedule)
}

export class RoutineStore extends EventEmitter<{ changed: [Routine[]] }> {
  readonly #path: string
  #items: Routine[]
  #lookups: RoutineLookups = OPEN

  constructor(dataDir: string) {
    super()
    this.#path = join(dataDir, 'routines.json')
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.#path, 'utf8'))
    } catch {
      raw = undefined
    }
    const rows = Array.isArray(raw) ? raw.filter(isRow).map(normalizeRoutine) : []
    this.#items = rows.map((r) => r.routine)
    if (rows.some((r) => r.migrated)) {
      // Keep the old file once, then write the migrated rows so this runs once.
      const backup = `${this.#path}.bak`
      if (!existsSync(backup)) copyFileSync(this.#path, backup)
      writeAtomic(this.#path, JSON.stringify(this.#items, null, 2))
    }
  }

  /** Called by the feature once the companion, chat and skill stores exist. */
  bind(lookups: Partial<RoutineLookups>): void {
    this.#lookups = { ...OPEN, ...lookups }
  }

  list(): Routine[] {
    return this.#items.map((r) => this.#view(r))
  }

  get(id: string): Routine | undefined {
    const found = this.#items.find((r) => r.id === id)
    return found ? this.#view(found) : undefined
  }

  /** The Routines page's filters (SK-05). Without a status every routine is listed, past ones included. */
  query(filter: RoutineFilter = {}): Routine[] {
    return filterRoutines(this.list(), filter)
  }

  save(input: RoutineSaveInput, now = Date.now()): Routine {
    const existing = input.id ? this.#items.find((r) => r.id === input.id) : undefined
    if (input.id && !existing && input.revision !== undefined) throw new Error('This routine was deleted.')
    if (existing && input.revision !== undefined && input.revision !== existing.revision) throw new Error(ROUTINE_CHANGED_ELSEWHERE)
    const name = input.name.trim()
    if (!name) throw new Error('Give the routine a name.')
    const skillId = input.skillId ?? null
    if (!input.prompt.trim() && !skillId) throw new Error('Tell the routine what to do, or pick a skill.')
    if (skillId && !this.#lookups.skillExists(skillId)) throw new Error('That skill no longer exists. Pick another, or write the instructions.')
    const timeZone = input.timeZone === undefined ? (existing?.timeZone ?? null) : input.timeZone
    const owner: Owner = input.companionId ?? input.owner ?? existing?.owner ?? SHARED_OWNER
    if (owner !== SHARED_OWNER && !this.#lookups.companionExists(owner)) throw new Error('Pick a companion to run it.')
    const { schedule, notice } = migrateSchedule(input.schedule, now, timeZone)
    const scheduleChanged = !existing || JSON.stringify(existing.schedule) !== JSON.stringify(schedule)
    validateSchedule(schedule, { now, timeZone, requireFuture: input.enabled && scheduleChanged })
    const destination = input.destination ?? existing?.destination ?? { kind: 'new-chat' }
    if (destination.kind === 'append') {
      const problem = this.#lookups.chatProblem(destination.chatId)
      if (problem === 'private') throw new Error('Private chats can’t receive routine runs. Pick another chat, or start a new chat each run.')
      if (problem === 'missing') throw new Error('That chat was deleted. Pick another chat, or start a new chat each run.')
    }
    const routine: Routine = {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: name.slice(0, 80),
      prompt: input.prompt.trim(),
      schedule,
      enabled: input.enabled,
      lastRunAt: existing?.lastRunAt ?? null,
      lastChatId: existing?.lastChatId ?? null,
      lastStatus: existing?.lastStatus ?? null,
      // A one-off time that passed gives null, so a task that ran stays in Past until its time changes.
      nextRunAt: input.enabled ? nextRunAfter(schedule, now, timeZone) : null,
      owner,
      timeZone,
      skillId,
      destination,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      needsCompanion: false,
      notice: scheduleChanged ? notice : (existing?.notice ?? null),
      notifyIf: input.notifyIf === undefined ? (existing?.notifyIf ?? '') : input.notifyIf.trim().slice(0, NOTIFY_IF_MAX),
    }
    return this.#put(routine)
  }

  setEnabled(id: string, enabled: boolean, now = Date.now()): Routine {
    const r = this.#items.find((x) => x.id === id)
    if (!r) throw new Error('This routine no longer exists.')
    const next = isPastRoutine(r) ? null : enabled ? nextRunAfter(r.schedule, now, r.timeZone) : null
    return this.#put({ ...r, enabled, nextRunAt: next, revision: r.revision + 1, updatedAt: now })
  }

  /** Run bookkeeping (last run, next run): no revision bump, so an open editor stays valid. */
  upsert(routine: Routine): Routine {
    return this.#put(routine)
  }

  remove(id: string): void {
    const before = this.#items.length
    this.#items = this.#items.filter((r) => r.id !== id)
    if (this.#items.length !== before) this.#save()
  }

  ownedBy(owner: Owner): Routine[] {
    return this.list().filter((r) => r.owner === owner)
  }

  /**
   * Its companion was deleted. The routines stay, waiting for you to pick
   * another companion (SK-05); they don't run until then.
   */
  removeOwned(owner: Owner): void {
    if (this.#items.some((r) => r.owner === owner)) this.emit('changed', this.list())
  }

  #view(r: Routine): Routine {
    const needsCompanion = r.owner !== SHARED_OWNER && !this.#lookups.companionExists(r.owner)
    return needsCompanion === r.needsCompanion ? { ...r } : { ...r, needsCompanion }
  }

  #put(routine: Routine): Routine {
    const stored = { ...routine, needsCompanion: false }
    const index = this.#items.findIndex((r) => r.id === routine.id)
    if (index === -1) this.#items.push(stored)
    else this.#items[index] = stored
    this.#save()
    return this.#view(stored)
  }

  #save(): void {
    writeAtomic(this.#path, JSON.stringify(this.#items, null, 2))
    this.emit('changed', this.list())
  }
}
