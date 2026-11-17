/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }))

import { DEFAULT_SITE_SUGGESTION_SETTINGS, SUGGESTION_TASKS_MAX, matchSite, suggestionHost, suggestionsAllowed, type SiteSuggestion, type SuggestionConnector } from '../src/shared/siteSuggestions'
import { SiteSuggestions, tasksFor, type SiteSuggestionDeps } from '../src/main/siteSuggestions'

// OV-23: site suggestions are opt-in, respect
// snooze, per-site and everywhere off switches and the exclusion rules.

const on = { enabled: true, offSites: [], snoozedUntil: null }
const never = (): boolean => false

describe('gating', () => {
  it('is off by default', () => {
    expect(DEFAULT_SITE_SUGGESTION_SETTINGS.enabled).toBe(false)
    expect(suggestionsAllowed('https://zoom.us/j/123456789', DEFAULT_SITE_SUGGESTION_SETTINGS, 0, never)).toBe(false)
  })

  it('respects snooze until it runs out', () => {
    const snoozed = { ...on, snoozedUntil: 1000 }
    expect(suggestionsAllowed('https://figma.com/', snoozed, 999, never)).toBe(false)
    expect(suggestionsAllowed('https://figma.com/', snoozed, 1000, never)).toBe(true)
  })

  it('respects sites turned off, including their subdomains', () => {
    const off = { ...on, offSites: ['slack.com'] }
    expect(suggestionsAllowed('https://acme.slack.com/archives/x', off, 0, never)).toBe(false)
    expect(suggestionsAllowed('https://www.slack.com/', off, 0, never)).toBe(false)
    expect(suggestionsAllowed('https://notslack.com/', off, 0, never)).toBe(true)
  })

  it('respects exclusions, and only offers on web pages', () => {
    expect(suggestionsAllowed('https://bank.example/', on, 0, (u) => u.includes('bank'))).toBe(false)
    expect(suggestionsAllowed('atelier://settings', on, 0, never)).toBe(false)
    expect(suggestionsAllowed('file:///Users/x/a.html', on, 0, never)).toBe(false)
    expect(suggestionHost('https://WWW.Figma.com/file/x')).toBe('figma.com')
  })
})

describe('matching', () => {
  const directory = [
    { id: 'linear', name: 'Linear', site: 'linear.app' },
    { id: 'notion', name: 'Notion', site: 'notion.so' },
  ]
  const connector = (over: Partial<SuggestionConnector>): SuggestionConnector => ({ id: 'c1', name: 'My Linear', enabled: true, directoryId: 'linear', url: 'https://mcp.linear.app/sse', ...over })

  it('prefers a connector you have, then one to connect, then an app', () => {
    expect(matchSite('https://linear.app/acme/issue/X-1', { connectors: [connector({})], directory, appLink: { key: 'linear', app: 'Linear' } })).toEqual({ kind: 'connector', connectorId: 'c1', name: 'Linear' })
    expect(matchSite('https://linear.app/acme', { connectors: [], directory, appLink: { key: 'linear', app: 'Linear' } })).toEqual({ kind: 'directory', directoryId: 'linear', name: 'Linear' })
    expect(matchSite('https://zoom.us/j/1', { connectors: [], directory, appLink: { key: 'zoom', app: 'Zoom' } })).toEqual({ kind: 'app-link', key: 'zoom', app: 'Zoom' })
    expect(matchSite('https://example.com/', { connectors: [], directory, appLink: null })).toBeNull()
  })

  it('skips switched-off connectors and matches a custom connector by its domain', () => {
    expect(matchSite('https://linear.app/x', { connectors: [connector({ enabled: false })], directory: [], appLink: null })).toBeNull()
    expect(matchSite('https://app.acme.dev/board', { connectors: [connector({ directoryId: null, name: 'Acme', url: 'https://mcp.acme.dev/' })], directory: [], appLink: null })).toMatchObject({ kind: 'connector', name: 'Acme' })
  })

  it('offers one to three of Atelier’s own tasks, none for a connector you still have to connect', () => {
    const t = (key: string) => key
    expect(tasksFor({ kind: 'app-link', key: 'zoom', app: 'Zoom' }, t).map((x) => x.id)).toEqual(['meetingPrep', 'summarize'])
    expect(tasksFor({ kind: 'app-link', key: 'unknown', app: 'X' }, t).map((x) => x.id)).toEqual(['summarize'])
    expect(tasksFor({ kind: 'connector', connectorId: 'c', name: 'Linear' }, t)).toHaveLength(2)
    expect(tasksFor({ kind: 'directory', directoryId: 'd', name: 'Linear' }, t)).toEqual([])
    for (const key of ['zoom', 'slack', 'spotify', 'figma', 'github']) expect(tasksFor({ kind: 'app-link', key, app: 'A' }, t).length).toBeLessThanOrEqual(SUGGESTION_TASKS_MAX)
  })
})

describe('SiteSuggestions', () => {
  let dir: string
  let urls: Record<string, string | null>
  let sent: Array<{ tabId: string; suggestion: SiteSuggestion | null }>
  let opened: string[]
  let now: number

  const make = (over: Partial<SiteSuggestionDeps> = {}): SiteSuggestions =>
    new SiteSuggestions({
      dataDir: dir,
      tabUrl: (id) => urls[id] ?? null,
      connectors: () => [],
      directory: () => [],
      excluded: (url) => url.includes('private.example'),
      installed: (scheme) => scheme !== 'figma',
      openExternal: (url) => opened.push(url),
      newChat: () => 'new-chat',
      chatExists: (id) => id === 'chat-1',
      broadcast: (e) => sent.push({ tabId: e.tabId, suggestion: e.suggestion }),
      now: () => now,
      ...over,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-suggest-'))
    urls = { t1: 'https://acme.zoom.us/j/123456789', t2: 'https://www.figma.com/design/Ab1/x' }
    sent = []
    opened = []
    now = 1_000
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('shows nothing until opted in, then an app-link suggestion', () => {
    const s = make()
    expect(s.current('t1')).toBeNull()
    s.update({ enabled: true })
    expect(s.current('t1')).toMatchObject({ tabId: 't1', kind: 'app-link', app: 'Zoom', origin: 'https://acme.zoom.us' })
    // Not installed: no app-link suggestion.
    expect(s.current('t2')).toBeNull()
    // The opt-in is remembered.
    expect(make().settings().enabled).toBe(true)
  })

  it('opens in the app without the opt-in, only when installed', () => {
    const s = make()
    expect(s.openInApp('t1')).toBe(true)
    expect(opened).toEqual(['zoommtg://zoom.us/join?action=join&confno=123456789'])
    expect(s.openInApp('t2')).toBe(false)
    urls.t3 = null
    expect(s.openInApp('t3')).toBe(false)
  })

  it('"not now" hides it for the tab until it leaves the site', () => {
    const s = make()
    s.update({ enabled: true })
    s.refresh('t1')
    s.dismiss('t1', 'once')
    expect(s.current('t1')).toBeNull()
    expect(sent.at(-1)).toEqual({ tabId: 't1', suggestion: null })
    urls.t1 = 'https://example.com/'
    s.refresh('t1')
    urls.t1 = 'https://acme.zoom.us/j/123456789'
    s.refresh('t1')
    expect(sent.at(-1)?.suggestion?.app).toBe('Zoom')
  })

  it('snoozes, turns off a site, and turns off everywhere', () => {
    const s = make()
    s.update({ enabled: true })
    s.dismiss('t1', { snoozeUntil: 5_000 })
    expect(s.current('t1')).toBeNull()
    now = 6_000
    expect(s.current('t1')).not.toBeNull()
    s.dismiss('t1', 'site')
    expect(s.settings().offSites).toEqual(['acme.zoom.us'])
    expect(s.current('t1')).toBeNull()
    s.update({ offSites: [] })
    s.dismiss('t1', 'everywhere')
    expect(s.settings().enabled).toBe(false)
  })

  it('respects the exclusion rules', () => {
    const s = make({ installed: () => true })
    s.update({ enabled: true })
    urls.t1 = 'https://zoom.private.example/j/123456789'
    expect(s.current('t1')).toBeNull()
  })

  it('broadcasts only when the suggestion changes', () => {
    const s = make()
    s.update({ enabled: true })
    s.refresh('t1')
    s.refresh('t1')
    expect(sent.filter((e) => e.tabId === 't1')).toHaveLength(1)
  })

  it('drafts into a new or the attached chat, with clear errors', () => {
    const s = make()
    s.update({ enabled: true })
    const task = s.current('t1')!.tasks[0]!
    expect(s.draft('t1', task.id, 'new')).toBe('new-chat')
    expect(s.draft('t1', task.id, { chatId: 'chat-1' })).toBe('chat-1')
    expect(() => s.draft('t1', task.id, { chatId: 'gone' })).toThrow(/no longer exists/)
    expect(() => s.draft('t1', 'nope', 'new')).toThrow(/no longer offered/)
    s.dismiss('t1', 'everywhere')
    expect(() => s.draft('t1', task.id, 'new')).toThrow(/no longer available/)
  })

  it('still offers the app link when the connector list is unavailable', () => {
    const s = make({
      connectors: () => {
        throw new Error('not ready')
      },
    })
    s.update({ enabled: true })
    expect(s.current('t1')?.kind).toBe('app-link')
  })
})
