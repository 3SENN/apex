/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatContextPage } from '../src/shared/chatContext'
import { ContextRegistry, type ContextDeps } from '../src/main/intake/context'

// CH-34: the pages in each chat, what is in context, and refusing to remove a
// page the chat's agent controls.

function setup(over: Partial<ContextDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-context-'))
  const emitted: { chatId: string; pages: ChatContextPage[] }[] = []
  const calls: string[] = []
  let now = 1000
  const deps: ContextDeps = {
    dir,
    emit: (chatId, pages) => emitted.push({ chatId, pages }),
    controlledTabs: () => [],
    tabInfo: () => null,
    focusTab: (id) => calls.push(`focus ${id}`),
    closeTab: (id) => calls.push(`close ${id}`),
    now: () => (now += 10),
    ...over,
  }
  return { registry: new ContextRegistry(deps), deps, dir, emitted, calls }
}

const page = (tabId: string | null, source: 'opened' | 'acted' | 'attached', url = `https://${tabId ?? 'x'}.test/`) => ({ tabId, url, title: `T ${tabId}`, favicon: null, source })

describe('ContextRegistry', () => {
  it('lists pages newest first; an opened page joins the context once used', () => {
    const { registry, emitted } = setup()
    const chat = randomUUID()
    registry.record(chat, page('a', 'opened'))
    registry.record(chat, page('b', 'attached'))
    expect(registry.list(chat).map((p) => [p.tabId, p.inContext])).toEqual([['b', true], ['a', false]])
    expect(registry.inContext(chat).map((p) => p.tabId)).toEqual(['b'])
    registry.record(chat, page('a', 'acted'))
    expect(registry.list(chat).find((p) => p.tabId === 'a')).toMatchObject({ source: 'acted', inContext: true })
    // A weaker reason never replaces a stronger one.
    registry.record(chat, page('b', 'opened'))
    expect(registry.list(chat).find((p) => p.tabId === 'b')?.source).toBe('attached')
    expect(emitted.at(-1)?.chatId).toBe(chat)
  })

  it('refuses to remove or close a page the agent controls', () => {
    const { registry, calls } = setup()
    const chat = randomUUID()
    registry.record(chat, page('a', 'acted'))
    registry.setControlled(chat, ['a'])
    expect(registry.list(chat)[0]?.controlled).toBe(true)
    expect(() => registry.remove(chat, 'a')).toThrow("This page can't be removed while the agent is using it")
    expect(() => registry.close(chat, 'a')).toThrow("This page can't be closed while the agent is using it")
    registry.focus(chat, 'a')
    registry.setControlled(chat, [])
    registry.close(chat, 'a')
    expect(calls).toEqual(['focus a', 'close a'])
    registry.remove(chat, 'a')
    expect(registry.list(chat)).toEqual([])
    expect(() => registry.remove(chat, 'a')).toThrow('This page is no longer in the chat')
  })

  it("also follows the host's live owners", () => {
    const chat = randomUUID()
    const { registry } = setup({ controlledTabs: (id) => (id === chat ? ['a'] : []) })
    registry.record(chat, page('a', 'opened'))
    expect(() => registry.remove(chat, 'a')).toThrow()
  })

  it('keeps a closed tab listed without its tab, and saves pages per chat', () => {
    const { registry, deps, dir } = setup()
    const chat = randomUUID()
    registry.record(chat, page('a', 'acted'))
    registry.tabClosed('a')
    expect(registry.list(chat)[0]).toMatchObject({ tabId: null, inContext: true })
    registry.record(chat, page('b', 'attached'))
    const saved = JSON.parse(readFileSync(join(dir, `${chat}.context.json`), 'utf8')) as { pages: unknown[] }
    expect(saved.pages).toHaveLength(2)
    // Tab ids belong to one launch: a reload keeps the pages without them.
    const reloaded = new ContextRegistry(deps)
    expect(reloaded.list(chat).map((p) => p.tabId)).toEqual([null, null])
  })

  it('uses the live title and favicon while the tab still shows the page', () => {
    const { registry } = setup({ tabInfo: () => ({ url: 'https://a.test/', title: 'Live', favicon: 'data:image/png;base64,AA==' }) })
    const chat = randomUUID()
    registry.record(chat, page('a', 'acted'))
    expect(registry.list(chat)[0]).toMatchObject({ title: 'Live', favicon: 'data:image/png;base64,AA==' })
  })

  it('detaches only attached pages, copies for a duplicate and removes with the chat', () => {
    const { registry, dir } = setup()
    const chat = randomUUID()
    const copy = randomUUID()
    registry.record(chat, page('a', 'attached'))
    registry.record(chat, page('b', 'acted'))
    registry.detach(chat, 'a')
    registry.detach(chat, 'b')
    expect(registry.list(chat).map((p) => p.tabId)).toEqual(['b'])
    registry.copyChat(chat, copy)
    expect(registry.list(copy).map((p) => p.tabId)).toEqual(['b'])
    registry.removeChat(chat)
    expect(existsSync(join(dir, `${chat}.context.json`))).toBe(false)
    expect(registry.list(chat)).toEqual([])
  })

  it('ignores ids that are not chat ids', () => {
    const { registry, dir } = setup()
    registry.record('../evil', page('a', 'attached'))
    expect(registry.list('../evil')).toEqual([])
    expect(existsSync(join(dir, '../evil.context.json'))).toBe(false)
  })
})
