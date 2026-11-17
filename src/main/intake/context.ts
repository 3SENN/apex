/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatContextPage, ChatContextSource } from '@shared/chatContext'
import { mainT } from '../i18n/mainT'
import { writeAtomic } from '../settings'
import type { ChatContextRegistry } from './types'

// The pages in each chat (CH-34): pages the agent opened or acted on (the
// agent turn records them) and tabs attached as context. Saved per chat in
// userData/chats/<id>.context.json. A page the chat's agent controls can't be
// removed or closed from the menu; a closed tab's page stays listed with a
// null tabId, because its content is still in the conversation.

export interface ContextDeps {
  /** userData/chats */
  dir: string
  emit(chatId: string, pages: ChatContextPage[]): void
  /** The tabs this chat's agent controls right now (the host's owners). */
  controlledTabs(chatId: string): readonly string[]
  /** The live tab, for its current favicon and title. */
  tabInfo(tabId: string): { url: string; title: string; favicon: string | null } | null
  focusTab(tabId: string): void
  closeTab(tabId: string): void
  now?: () => number
}

type StoredPage = Omit<ChatContextPage, 'controlled'>

/** A chat keeps its most recent pages; older ones drop off. */
const PAGES_MAX = 200
const CHAT_ID = /^[0-9a-f-]{36}$/
/** A stronger reason replaces a weaker one: attaching beats acting beats opening. */
const STRENGTH: Record<ChatContextSource, number> = { opened: 0, acted: 1, attached: 2 }

export class ContextRegistry implements ChatContextRegistry {
  readonly #deps: ContextDeps
  readonly #pages = new Map<string, StoredPage[]>()
  /** What the agent turn last said each chat controls (setControlled). */
  readonly #controlled = new Map<string, Set<string>>()

  constructor(deps: ContextDeps) {
    this.#deps = deps
  }

  record(chatId: string, page: { tabId: string | null; url: string; title: string; favicon: string | null; source: ChatContextSource }): void {
    if (!CHAT_ID.test(chatId) || !page.url) return
    const pages = this.#load(chatId)
    const existing = pages.find((p) => (page.tabId !== null && p.tabId === page.tabId) || (p.tabId === null && p.url === page.url))
    if (existing) {
      existing.tabId = page.tabId ?? existing.tabId
      existing.url = page.url
      existing.title = page.title || existing.title
      existing.favicon = page.favicon ?? existing.favicon
      if (STRENGTH[page.source] > STRENGTH[existing.source]) existing.source = page.source
      existing.inContext = existing.inContext || page.source !== 'opened'
    } else {
      // An opened page isn't in context until the agent reads or acts on it.
      pages.push({ tabId: page.tabId, url: page.url, title: page.title, favicon: page.favicon, source: page.source, inContext: page.source !== 'opened', addedAt: this.#now() })
      if (pages.length > PAGES_MAX) pages.splice(0, pages.length - PAGES_MAX)
    }
    this.#changed(chatId)
  }

  setControlled(chatId: string, tabIds: readonly string[]): void {
    const next = new Set(tabIds)
    const before = this.#controlled.get(chatId)
    if (before && before.size === next.size && [...next].every((t) => before.has(t))) return
    this.#controlled.set(chatId, next)
    if (this.#load(chatId).length > 0) this.#changed(chatId)
  }

  inContext(chatId: string): ChatContextPage[] {
    return this.list(chatId).filter((p) => p.inContext)
  }

  /** Newest first, with live favicons and whether the agent controls each tab now. */
  list(chatId: string): ChatContextPage[] {
    const controlled = this.#controlledNow(chatId)
    return [...this.#load(chatId)]
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((p) => {
        const live = p.tabId ? this.#deps.tabInfo(p.tabId) : null
        const same = live !== null && live.url === p.url
        return { ...p, title: same && live.title ? live.title : p.title, favicon: (same ? live.favicon : null) ?? p.favicon, controlled: p.tabId !== null && controlled.has(p.tabId) }
      })
  }

  remove(chatId: string, tabId: string): void {
    const pages = this.#load(chatId)
    const index = pages.findIndex((p) => p.tabId === tabId)
    if (index < 0) throw new Error(mainT('intake.error.pageGone'))
    if (this.#controlledNow(chatId).has(tabId)) throw new Error(mainT('intake.error.controlled'))
    pages.splice(index, 1)
    this.#changed(chatId)
  }

  focus(chatId: string, tabId: string): void {
    if (!this.#load(chatId).some((p) => p.tabId === tabId)) throw new Error(mainT('intake.error.pageGone'))
    this.#deps.focusTab(tabId)
  }

  close(chatId: string, tabId: string): void {
    if (!this.#load(chatId).some((p) => p.tabId === tabId)) throw new Error(mainT('intake.error.pageGone'))
    if (this.#controlledNow(chatId).has(tabId)) throw new Error(mainT('intake.error.closeControlled'))
    this.#deps.closeTab(tabId)
  }

  /** An attached tab's chip was removed: its page leaves unless the agent also used it. */
  detach(chatId: string, tabId: string): void {
    const pages = this.#load(chatId)
    const index = pages.findIndex((p) => p.tabId === tabId && p.source === 'attached')
    if (index < 0) return
    pages.splice(index, 1)
    this.#changed(chatId)
  }

  /** A tab closed: every chat that lists it keeps the page, without the tab. */
  tabClosed(tabId: string): void {
    for (const [chatId, pages] of this.#pages) {
      let changed = false
      for (const p of pages) {
        if (p.tabId !== tabId) continue
        p.tabId = null
        changed = true
      }
      if (changed) this.#changed(chatId)
    }
  }

  removeChat(chatId: string): void {
    if (!CHAT_ID.test(chatId)) return
    this.#pages.delete(chatId)
    this.#controlled.delete(chatId)
    rmSync(this.#file(chatId), { force: true })
  }

  /** CH-47: a duplicate lists the same pages (tabs included: they are still open). */
  copyChat(fromChatId: string, toChatId: string): void {
    const pages = this.#load(fromChatId)
    if (pages.length === 0) return
    this.#pages.set(toChatId, pages.map((p) => ({ ...p })))
    this.#changed(toChatId)
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #file(chatId: string): string {
    return join(this.#deps.dir, `${chatId}.context.json`)
  }

  #controlledNow(chatId: string): Set<string> {
    return new Set([...(this.#controlled.get(chatId) ?? []), ...this.#deps.controlledTabs(chatId)])
  }

  #load(chatId: string): StoredPage[] {
    const loaded = this.#pages.get(chatId)
    if (loaded) return loaded
    let pages: StoredPage[] = []
    if (CHAT_ID.test(chatId)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(this.#file(chatId), 'utf8'))
        const list = (raw as { pages?: unknown }).pages
        // Tab ids are per launch, so tabs saved by an earlier launch are gone.
        if (Array.isArray(list)) pages = list.filter(isStoredPage).map((p) => ({ ...p, favicon: typeof p.favicon === 'string' ? p.favicon : null, tabId: null }))
      } catch {
        pages = []
      }
    }
    this.#pages.set(chatId, pages)
    return pages
  }

  #changed(chatId: string): void {
    const pages = this.#load(chatId)
    if (CHAT_ID.test(chatId)) writeAtomic(this.#file(chatId), JSON.stringify({ pages }))
    this.#deps.emit(chatId, this.list(chatId))
  }
}

function isStoredPage(v: unknown): v is StoredPage {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return typeof p.url === 'string' && typeof p.title === 'string' && (p.source === 'opened' || p.source === 'acted' || p.source === 'attached') && typeof p.inContext === 'boolean' && typeof p.addedAt === 'number'
}
