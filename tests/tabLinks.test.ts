/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { samePage } from '@shared/url'
import { systemPrompt } from '../src/main/agent/prompt'
import { TabRegistry } from '../src/main/tabRegistry'
import type { Tab } from '../src/main/tabs'
import { TAB_LINK, parseInline, safeHref } from '../src/renderer/src/chat/logic/markdown'

const fakeTab = (id: string, url: string, internalUrl: string | null = null): Tab =>
  ({ id, internalUrl, requestedUrl: url, view: { webContents: { isDestroyed: () => false, getURL: () => url } } }) as unknown as Tab

describe('tab links in chat', () => {
  it('keeps [title](tab:<id>) as a link and nothing else under tab:', () => {
    expect(safeHref('tab:t12')).toBe('tab:t12')
    expect(safeHref(' tab:t3 ')).toBe('tab:t3')
    for (const bad of ['tab:', 'tab:t', 'tab:12', 'tab:t1/x', 'tab:javascript:alert(1)', 'tab:../t1']) expect(safeHref(bad)).toBeNull()
    expect(parseInline('see [Flights](tab:t12) now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'tab:t12', children: [{ kind: 'text', text: 'Flights' }] },
      { kind: 'text', text: ' now' },
    ])
    expect(TAB_LINK.exec('tab:t12')?.[1]).toBe('t12')
  })

  it('treats addresses as the same page across a fragment, a trailing slash and host case', () => {
    expect(samePage('https://Example.com/a/', 'https://example.com/a#top')).toBe(true)
    expect(samePage('https://example.com/', 'https://example.com')).toBe(true)
    expect(samePage('https://example.com/a?q=1', 'https://example.com/a?q=2')).toBe(false)
    expect(samePage('http://example.com/a', 'https://example.com/a')).toBe(false)
    expect(samePage('mailto:a@b.c', 'mailto:a@b.c')).toBe(false)
  })

  it('remembers where a closed tab was, but not for an open one or a blank one', () => {
    const reg = new TabRegistry()
    reg.add(fakeTab('t1', 'https://example.com/flights'), 1)
    reg.add(fakeTab('t2', 'about:blank'), 1)
    reg.add(fakeTab('t3', '', 'atelier://routines'), 1)
    expect(reg.closedTab('t1')).toBeUndefined()
    reg.remove('t1', { private: true })
    reg.remove('t2')
    reg.remove('t3')
    expect(reg.closedTab('t1')).toEqual({ url: 'https://example.com/flights', private: true })
    expect(reg.closedTab('t2')).toBeUndefined()
    expect(reg.closedTab('t3')).toEqual({ url: 'atelier://routines', private: false })
  })

  it('asks the companion to link tabs by id when it works in the browser', () => {
    const base = { name: 'Pip', browser: true, routine: false, memory: false }
    expect(systemPrompt(base)).toContain('[Flights to Lisbon](tab:t12)')
    expect(systemPrompt({ ...base, browser: false })).not.toContain('tab:t12')
  })
})
