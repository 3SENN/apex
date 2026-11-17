/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  chatUrl,
  companionUrl,
  internalTitle,
  isInsecureUrl,
  omniboxToUrl,
  originOf,
  parseAgentNavigation,
  parseInternalUrl,
  resolveInternalUrl,
} from '@shared/url'
import { DESTINATIONS, SETTINGS_PAGES, isDestinationUrl } from '@shared/url'

describe('omniboxToUrl', () => {
  it('adds https to bare domains', () => {
    expect(omniboxToUrl('example.com', 'google')).toBe('https://example.com/')
    expect(omniboxToUrl('docs.example.co.uk/path?q=1', 'google')).toBe('https://docs.example.co.uk/path?q=1')
  })

  it('uses http for localhost and IP addresses', () => {
    expect(omniboxToUrl('localhost:3000', 'google')).toBe('http://localhost:3000/')
    expect(omniboxToUrl('192.168.1.10/admin', 'google')).toBe('http://192.168.1.10/admin')
  })

  it('keeps explicit http, https and file URLs', () => {
    expect(omniboxToUrl('https://example.com/a', 'google')).toBe('https://example.com/a')
    expect(omniboxToUrl('file:///Users/me/notes.html', 'google')).toBe('file:///Users/me/notes.html')
  })

  it('searches for text and refuses other schemes', () => {
    expect(omniboxToUrl('best pizza amsterdam', 'duckduckgo')).toBe('https://duckduckgo.com/?q=best%20pizza%20amsterdam')
    expect(omniboxToUrl('javascript:alert(1)', 'google')).toBe('https://www.google.com/search?q=javascript%3Aalert(1)')
    expect(omniboxToUrl('electron', 'bing')).toBe('https://www.bing.com/search?q=electron')
  })

  it('maps empty input to a blank page', () => {
    expect(omniboxToUrl('   ', 'google')).toBe('about:blank')
  })
})

describe('parseAgentNavigation', () => {
  it('recognizes history actions', () => {
    expect(parseAgentNavigation('back')).toEqual({ kind: 'history', action: 'back' })
    expect(parseAgentNavigation('reload')).toEqual({ kind: 'history', action: 'reload' })
  })

  it('treats a URL without a scheme as https', () => {
    expect(parseAgentNavigation('example.com/docs')).toEqual({ kind: 'url', url: 'https://example.com/docs' })
    expect(parseAgentNavigation('localhost:8080')).toEqual({ kind: 'url', url: 'https://localhost:8080/' })
  })

  it('refuses every scheme except http and https', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings']) {
      expect(() => parseAgentNavigation(url)).toThrow(/not allowed/)
    }
  })
})

describe('originOf', () => {
  it('returns the origin of web URLs and the input otherwise', () => {
    expect(originOf('https://shop.example.com/cart?x=1')).toBe('https://shop.example.com')
    expect(originOf('about:blank')).toBe('about:blank')
  })
})

describe('parseInternalUrl', () => {
  it('reads pages, sections, ids and items', () => {
    expect(parseInternalUrl('atelier://chats')).toEqual({ page: 'chats', section: null, id: null, item: null })
    expect(parseInternalUrl('atelier://settings/appearance')).toEqual({ page: 'settings', section: 'appearance', id: null, item: null })
    expect(parseInternalUrl('atelier://chat/3f2a-91_x')).toEqual({ page: 'chat', section: null, id: '3f2a-91_x', item: null })
    expect(parseInternalUrl('atelier://routines/r-1')).toEqual({ page: 'routines', section: null, id: 'r-1', item: null })
    expect(parseInternalUrl('atelier://companion/companion-1/skills/s-9')).toEqual({ page: 'companion', section: 'skills', id: 'companion-1', item: 's-9' })
    expect(parseInternalUrl('atelier://companion/companion-1')).toEqual({ page: 'companion', section: null, id: 'companion-1', item: null })
    expect(parseInternalUrl('atelier://history/?q=1#x')).toEqual({ page: 'history', section: null, id: null, item: null })
  })

  it('refuses unsafe ids and sections, and pages that need an id', () => {
    for (const url of [
      'atelier://chat',
      'atelier://chat/',
      'atelier://chat/../../etc',
      'atelier://chat/a%2Fb',
      'atelier://chat/a/b',
      'atelier://companion//general',
      'atelier://companion/c1/General',
      'atelier://companion/c1/general/x/y',
      'atelier://settings/a/b',
      'atelier://settings/<script>',
      'atelier://constructor',
      'atelier://__proto__',
      'https://atelier.example/chat/1',
    ]) {
      expect(parseInternalUrl(url), url).toBeNull()
    }
  })

  it('builds chat and companion addresses that parse back', () => {
    expect(parseInternalUrl(chatUrl('abc'))?.id).toBe('abc')
    expect(companionUrl('c1')).toBe('atelier://companion/c1')
    expect(companionUrl('c1', 'memory')).toBe('atelier://companion/c1/memory')
    expect(parseInternalUrl(companionUrl('c1', 'files', 'f-2'))).toEqual({ page: 'companion', section: 'files', id: 'c1', item: 'f-2' })
  })
})

describe('resolveInternalUrl', () => {
  it('redirects library sections to their destinations', () => {
    expect(resolveInternalUrl('atelier://library')).toBe('atelier://chats')
    expect(resolveInternalUrl('atelier://library/chats')).toBe('atelier://chats')
    expect(resolveInternalUrl('atelier://library/routines')).toBe('atelier://routines')
    expect(resolveInternalUrl('atelier://library/skills')).toBe('atelier://skills')
    expect(resolveInternalUrl('atelier://library/connectors')).toBe('atelier://connectors')
    expect(resolveInternalUrl('atelier://library/memory')).toBe('atelier://settings/memory')
    expect(resolveInternalUrl('atelier://library/whatever')).toBe('atelier://chats')
  })

  it('lands atelier://settings on its first page and follows renamed pages', () => {
    expect(resolveInternalUrl('atelier://settings')).toBe('atelier://settings/you')
    expect(resolveInternalUrl('atelier://settings/agent')).toBe('atelier://settings/model')
    expect(resolveInternalUrl('atelier://settings/connectors')).toBe('atelier://connectors')
    expect(resolveInternalUrl('atelier://settings/appearance')).toBe('atelier://settings/appearance')
  })

  it('keeps other pages and refuses unknown ones', () => {
    expect(resolveInternalUrl('atelier://chat/abc')).toBe('atelier://chat/abc')
    expect(resolveInternalUrl('atelier://nope')).toBeNull()
  })

  it('opens a renamed page from its old address, as saved tabs and bookmarks have it', () => {
    expect(resolveInternalUrl('atelier://boosts')).toBe('atelier://tweaks') // compatibility: atelier://boosts before the rename
    expect(resolveInternalUrl('atelier://boosts?site=example.com')).toBe('atelier://tweaks?site=example.com') // compatibility
    expect(parseInternalUrl('atelier://boosts')).toEqual({ page: 'tweaks', section: null, id: null, item: null }) // compatibility
    expect(resolveInternalUrl('atelier://boostsx')).toBeNull()
    expect(resolveInternalUrl('atelier://tweaks?site=example.com')).toBe('atelier://tweaks?site=example.com')
  })
})

describe('internalTitle', () => {
  const names = { chat: (id: string) => (id === 'c1' ? 'Trip to Lisbon' : null), companion: (id: string) => (id === 'p1' ? 'Pip' : null) }

  it('gives breadcrumbs for chats, settings and companions', () => {
    expect(internalTitle('atelier://chat/c1', names)).toEqual({ title: 'Trip to Lisbon', crumbs: ['Chat', 'Trip to Lisbon'] })
    expect(internalTitle('atelier://chat/unknown', names)).toEqual({ title: 'New chat', crumbs: ['Chat', 'New chat'] })
    expect(internalTitle('atelier://settings/appearance')).toEqual({ title: 'Settings', crumbs: ['Settings', 'Appearance'] })
    expect(internalTitle('atelier://settings/legacy')).toEqual({ title: 'Settings', crumbs: ['Settings'] })
    // The look editor sits under Companions.
    expect(internalTitle('atelier://settings/companion')).toEqual({ title: 'Settings', crumbs: ['Settings', 'Companions'] })
    expect(internalTitle('atelier://companion/p1/memory', names)).toEqual({ title: 'Pip', crumbs: ['Pip', 'Memory'] })
    expect(internalTitle('atelier://chats')).toEqual({ title: 'All chats', crumbs: ['All chats'] })
  })
})

describe('isInsecureUrl', () => {
  it('flags plain http except on this machine', () => {
    expect(isInsecureUrl('http://example.com/')).toBe(true)
    expect(isInsecureUrl('https://example.com/')).toBe(false)
    expect(isInsecureUrl('http://localhost:3000/')).toBe(false)
    expect(isInsecureUrl('http://127.0.0.1/')).toBe(false)
    expect(isInsecureUrl('http://[::1]:8080/')).toBe(false)
    expect(isInsecureUrl('atelier://chats')).toBe(false)
  })
})

describe('passwords and meetings routes', () => {
  it('knows atelier://passwords and atelier://meetings, with a meeting id', () => {
    expect(parseInternalUrl('atelier://passwords')).toEqual({ page: 'passwords', section: null, id: null, item: null })
    expect(parseInternalUrl('atelier://passwords?site=example.com')?.page).toBe('passwords')
    expect(parseInternalUrl('atelier://meetings?filter=recordings&q=standup')).toEqual({ page: 'meetings', section: null, id: null, item: null })
    expect(parseInternalUrl('atelier://meetings/0b9e2d4c-1a2b-4c3d-8e9f-001122334455')?.id).toBe('0b9e2d4c-1a2b-4c3d-8e9f-001122334455')
    expect(parseInternalUrl('atelier://meetings/../etc')).toBeNull()
  })

  it('adds Meetings right after Skills, on the destination surface', () => {
    expect(DESTINATIONS.indexOf('meetings')).toBe(DESTINATIONS.indexOf('skills') + 1)
    expect(isDestinationUrl('atelier://meetings')).toBe(true)
    expect(isDestinationUrl('atelier://passwords')).toBe(false)
  })

  it('adds the Voice, Transcription and Passwords settings pages', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id)
    expect(ids).toEqual(expect.arrayContaining(['voice', 'transcription', 'passwords']))
    expect(internalTitle('atelier://settings/passwords').crumbs).toEqual(['Settings', 'Passwords and autofill'])
  })
})
