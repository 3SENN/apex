/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATEGORIES, connectRequestOf, connectorConnectUrl } from '@shared/connectors'
import { DIRECTORY, directoryProblems } from '../src/main/connectors/directory'
import { FaviconCache, type IconFetch } from '../src/main/connectors/favicons'
import { setupConnectors } from '../src/main/connectors/service'
import { ConnectorStore } from '../src/main/connectors/store'
import entries from '../src/main/connectors/directory.json'
import { directoryGroups, filterConnectors, type ConnectorRow, type DirectoryFilter } from '../src/renderer/src/connectors/logic/directory'

// The curated directory stays valid (unique ids, https only, Atelier's
// categories), favicons fall back to the generic icons, and the page's
// grouping and filters (SK-13).

describe('the connector directory', () => {
  it('has only valid entries', () => {
    expect(directoryProblems(entries as never)).toEqual([])
    expect(DIRECTORY.length).toBe(entries.length)
    expect(new Set(DIRECTORY.map((e) => e.id)).size).toBe(DIRECTORY.length)
    for (const e of DIRECTORY) {
      expect(new URL(e.url).protocol).toBe('https:')
      expect(CONNECTOR_CATEGORIES).toContain(e.category)
    }
    expect(DIRECTORY.some((e) => e.setup === 'google')).toBe(true)
  })

  it('catches bad entries', () => {
    const bad = directoryProblems([
      { id: 'a', name: 'A', description: 'x', category: 'work', url: 'http://a.example/mcp', auth: 'oauth', site: 'a.example', docsUrl: 'https://a.example' },
      { id: 'a', name: 'B', description: 'x', category: 'nope', url: 'https://b.example/mcp', auth: 'token', site: 'https://b.example', docsUrl: 'https://b.example' },
    ])
    expect(bad.map((p) => p.problem)).toEqual(['not https: http://a.example/mcp', 'duplicate id', 'unknown category', 'site must be a bare host name'])
  })

  it('round-trips the deep link', () => {
    expect(connectRequestOf(connectorConnectUrl('linear'))).toBe('linear')
    expect(connectRequestOf('atelier://connectors?connect=../etc')).toBeNull()
  })
})

describe('favicons', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'atelier-icons-'))
  const image: IconFetch = async () => ({ ok: true, contentType: 'image/png', body: new Uint8Array([1, 2, 3]).buffer })

  it('fall back to the generic icon when off, failing or not an image', async () => {
    expect(await new FaviconCache(dir(), null).get('linear.app')).toBeNull()
    expect(await new FaviconCache(dir(), async () => Promise.reject(new Error('offline'))).get('linear.app')).toBeNull()
    expect(await new FaviconCache(dir(), async () => ({ ok: true, contentType: 'text/html', body: new ArrayBuffer(4) })).get('linear.app')).toBeNull()
  })

  it('cache hits on disk, and only fetch sites Atelier knows', async () => {
    const d = dir()
    let calls = 0
    const counting: IconFetch = async (url, signal) => {
      calls++
      return image(url, signal)
    }
    expect(await new FaviconCache(d, counting).get('linear.app')).toBe('data:image/png;base64,AQID')
    expect(await new FaviconCache(d, counting).get('linear.app')).toBe('data:image/png;base64,AQID')
    expect(calls).toBe(1)
    const svc = setupConnectors({ dataDir: d, store: new ConnectorStore(d), iconFetch: counting })
    expect(await svc.services.connectors.favicon('example.org')).toBeNull()
    expect(await svc.services.connectors.favicon('sentry.io')).toBe('data:image/png;base64,AQID')
    await svc.dispose()
  })
})

describe('directory page logic', () => {
  const base = { query: '', status: 'all', category: 'all' } satisfies DirectoryFilter
  const conn = (over: Record<string, unknown>) => ({ id: 'c', displayName: 'Notion', source: 'directory', directoryId: 'notion', health: 'ok', enabled: true, url: 'https://mcp.notion.com/mcp', ...over }) as unknown as ConnectorRow

  it('groups connected, your servers and the directory by category, minus what is connected', () => {
    const groups = directoryGroups([conn({}), conn({ id: 'd', displayName: 'Mine', source: 'custom', directoryId: null })], DIRECTORY, base)
    expect(groups.map((g) => g.id)).toEqual(['connected', 'custom', ...CONNECTOR_CATEGORIES.filter((c) => DIRECTORY.some((e) => e.category === c))])
    expect(groups.find((g) => g.id === 'work')?.entries.map((e) => e.id)).not.toContain('notion')
  })

  it('searches everything and applies status and category filters', () => {
    const list = [conn({}), conn({ id: 'x', displayName: 'Broken', directoryId: 'linear', health: 'needs-reconnect' })]
    expect(directoryGroups(list, DIRECTORY, { ...base, query: 'jira' }).flatMap((g) => g.entries.map((e) => e.id))).toEqual(['atlassian'])
    expect(filterConnectors(list, { ...base, status: 'attention' }).map((c) => c.id)).toEqual(['x'])
    expect(directoryGroups(list, DIRECTORY, { ...base, status: 'available', category: 'code' }).map((g) => g.id)).toEqual(['code'])
  })
})
