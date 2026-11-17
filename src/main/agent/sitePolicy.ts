/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Saved site rules for the agent (ST-13), app-wide in
// userData/agent-site-rules.json: per origin, allow, ask or never, plus the
// kinds of consequential action you allowed for good there. Every agent step
// reads the rules afresh, so a change in Settings applies at the next step.
// The file also keeps how many remembered approvals each chat holds, so
// Saved permissions can list them without opening every chat.
import { EventEmitter } from 'node:events'
import { ACTION_KINDS, SITE_ACCESS, type ActionKind, type SiteAccess, type SiteRule } from '@shared/agentTools'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'

const RULES_MAX = 2000
const CHATS_MAX = 5000

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The origin a rule is keyed by: scheme, host and port of an http(s) address, or null. */
export function ruleOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

function ruleFrom(raw: unknown): SiteRule | null {
  if (!isObject(raw) || typeof raw.origin !== 'string') return null
  const origin = ruleOrigin(raw.origin)
  const access = SITE_ACCESS.find((a) => a === raw.access)
  if (!origin || !access) return null
  const actions: SiteRule['actions'] = {}
  if (isObject(raw.actions)) for (const kind of ACTION_KINDS) if (raw.actions[kind] === 'allow') actions[kind] = 'allow'
  return { origin, access, actions, updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0 }
}

export interface SiteRulesOptions {
  /** Settings › Agent permissions › default for sites without a rule. */
  defaultAccess(): 'allow' | 'ask'
  now?: () => number
}

export class SiteRulesStore extends EventEmitter<{ changed: [SiteRule[]] }> {
  readonly #path: string
  readonly #options: SiteRulesOptions
  #rules = new Map<string, SiteRule>()
  #chats = new Map<string, number>()

  constructor(path: string, options: SiteRulesOptions) {
    super()
    this.#path = path
    this.#options = options
    const raw = readJson(path)
    const file = isObject(raw) ? raw : {}
    for (const entry of Array.isArray(file.rules) ? file.rules.slice(0, RULES_MAX) : []) {
      const rule = ruleFrom(entry)
      if (rule) this.#rules.set(rule.origin, rule)
    }
    if (isObject(file.chats)) {
      for (const [chatId, count] of Object.entries(file.chats).slice(0, CHATS_MAX)) {
        if (typeof count === 'number' && count > 0) this.#chats.set(chatId, Math.floor(count))
      }
    }
  }

  list(): SiteRule[] {
    return [...this.#rules.values()].sort((a, b) => a.origin.localeCompare(b.origin))
  }

  get(origin: string): SiteRule | null {
    const key = ruleOrigin(origin)
    return key ? (this.#rules.get(key) ?? null) : null
  }

  /** The access the agent has on an origin right now: its rule, or the default. */
  access(origin: string): SiteAccess {
    return this.get(origin)?.access ?? this.#options.defaultAccess()
  }

  /** Whether a saved site rule allows this kind of consequential action here. */
  allows(origin: string, action: ActionKind): boolean {
    return this.get(origin)?.actions[action] === 'allow'
  }

  set(origin: string, access: SiteAccess): SiteRule {
    const key = this.#key(origin)
    const rule: SiteRule = { origin: key, access, actions: { ...(this.#rules.get(key)?.actions ?? {}) }, updatedAt: this.#now() }
    this.#rules.set(key, rule)
    this.#save()
    return { ...rule, actions: { ...rule.actions } }
  }

  /** "Always on this site" for one kind of action; the site itself becomes allowed. */
  allowAction(origin: string, action: ActionKind): SiteRule {
    const key = this.#key(origin)
    const existing = this.#rules.get(key)
    const rule: SiteRule = { origin: key, access: existing?.access === 'never' ? 'never' : 'allow', actions: { ...(existing?.actions ?? {}), [action]: 'allow' }, updatedAt: this.#now() }
    this.#rules.set(key, rule)
    this.#save()
    return { ...rule, actions: { ...rule.actions } }
  }

  remove(origin: string): void {
    const key = ruleOrigin(origin)
    if (key && this.#rules.delete(key)) this.#save()
  }

  /** Chats that remember approvals, with how many. */
  chatGrants(): Array<{ chatId: string; grants: number }> {
    return [...this.#chats].map(([chatId, grants]) => ({ chatId, grants }))
  }

  setChatGrants(chatId: string, grants: number): void {
    const before = this.#chats.get(chatId) ?? 0
    if (before === grants) return
    if (grants > 0) this.#chats.set(chatId, grants)
    else this.#chats.delete(chatId)
    this.#save(false)
  }

  /** Chats deleted for good take their grants with them. */
  forgetChats(ids: readonly string[]): void {
    let changed = false
    for (const id of ids) changed = this.#chats.delete(id) || changed
    if (changed) this.#save(false)
  }

  #key(origin: string): string {
    const key = ruleOrigin(origin)
    if (!key) throw new Error('Site rules are for web addresses (http or https).')
    return key
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }

  #save(emit = true): void {
    writeAtomic(this.#path, JSON.stringify({ version: 1, rules: this.list(), chats: Object.fromEntries(this.#chats) }))
    if (emit) this.emit('changed', this.list())
  }
}
