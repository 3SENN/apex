/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WEB_APP_LIMITS, nameFromTitle, pageOfApp, suggestWebApps, webAppKey, type WebApp } from '@shared/webApps'
import { WEB_APPS_FILE, WebAppStore, findAppTab } from '../src/main/webApps'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 10, 5)

const app = (url: string, patch: Partial<WebApp> = {}): WebApp => ({ id: url, name: 'App', url, icon: null, addedAt: 0, lastOpenedAt: null, ...patch })

describe('web app addresses (WA-01)', () => {
  it('keys websites without their fragment and refuses anything else', () => {
    expect(webAppKey('https://mail.google.com/mail/u/0/#inbox')).toBe('https://mail.google.com/mail/u/0/')
    expect(webAppKey('apex://workspace')).toBeNull()
    expect(webAppKey('file:///tmp/a.html')).toBeNull()
    expect(webAppKey('not a url')).toBeNull()
  })

  it('tells which pages belong to an app', () => {
    expect(pageOfApp('https://mail.google.com/mail/u/0/#inbox', 'https://mail.google.com/mail/u/0/', false)).toBe(true)
    expect(pageOfApp('https://mail.google.com/mail/u/1/', 'https://mail.google.com/mail/u/0/', false)).toBe(false)
    expect(pageOfApp('https://www.figma.com/files/recent', 'https://www.figma.com/', true)).toBe(true)
    expect(pageOfApp('https://figma.com/files', 'https://www.figma.com/', true)).toBe(false)
    expect(pageOfApp('https://linear.app/team/issue-1', 'https://linear.app/team', false)).toBe(true)
    expect(pageOfApp('https://linear.app/teams', 'https://linear.app/team', false)).toBe(false)
  })

  it('names an app from its page title', () => {
    expect(nameFromTitle('Inbox (3) - Gmail', 'mail.google.com')).toBe('Gmail')
    expect(nameFromTitle('(2) Feed | LinkedIn', 'www.linkedin.com')).toBe('LinkedIn')
    expect(nameFromTitle('Figma', 'www.figma.com')).toBe('Figma')
    expect(nameFromTitle('', 'www.notion.so')).toBe('Notion')
    expect(nameFromTitle('x'.repeat(200), 'app.example.com')).toBe('App')
  })
})

describe('suggesting sites to save', () => {
  const recent = (n: number): number[] => Array.from({ length: n }, (_, i) => NOW - i * DAY)

  it('suggests the sites visited most in 30 days, not saved yet and not search engines', () => {
    const history = [
      { url: 'https://linear.app/team/a', title: 'Issue A · Linear', visits: 3, visitTimes: recent(3) },
      { url: 'https://linear.app/team/b', title: 'Issue B · Linear', visits: 4, visitTimes: recent(4) },
      { url: 'https://www.figma.com/files', title: 'Recent - Figma', visits: 9, visitTimes: recent(9) },
      { url: 'https://www.google.com/search?q=a', title: 'a - Google Search', visits: 40, visitTimes: recent(30) },
      { url: 'https://mail.google.com/mail/u/0/', title: 'Inbox - Gmail', visits: 20, visitTimes: recent(20) },
      { url: 'https://old.example.com/', title: 'Old', visits: 50, visitTimes: [NOW - 60 * DAY] },
      { url: 'https://rare.example.com/', title: 'Rare', visits: 2, visitTimes: recent(2) },
      { url: 'apex://workspace', title: 'Workspace', visits: 90 },
    ]
    const saved = [app('https://mail.google.com/mail/u/0/')]
    const out = suggestWebApps(history, saved, NOW, ['www.google.com'])
    expect(out.map((s) => s.host)).toEqual(['www.figma.com', 'linear.app'])
    expect(out[0]).toEqual({ url: 'https://www.figma.com/', host: 'www.figma.com', title: 'Figma', visits: 9 })
    expect(out[1]).toMatchObject({ url: 'https://linear.app/', title: 'Linear', visits: 7 })
  })

  it('caps the list', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ url: `https://site${i}.com/`, title: `Site ${i}`, visits: 10 + i }))
    expect(suggestWebApps(history, [], NOW, [], 3).map((s) => s.host)).toEqual(['site9.com', 'site8.com', 'site7.com'])
  })
})

describe('which tab is an app’s tab', () => {
  const windows = [
    { id: 'front', tabs: [{ id: 't1', url: 'https://news.example.com/' }, { id: 't2', url: 'https://www.figma.com/files/recent' }] },
    { id: 'back', tabs: [{ id: 't3', url: 'https://www.figma.com/design/abc' }, { id: 't4', url: 'https://mail.google.com/mail/u/1/' }] },
  ]
  const where = { windows: () => windows, tabs: (w: (typeof windows)[number]) => w.tabs }
  const figma = app('https://www.figma.com/')

  it('goes back to the tab it last opened while that tab is still on the app', () => {
    expect(findAppTab(figma, [figma], 't3', where)).toEqual({ win: windows[1], tabId: 't3' })
  })

  it('else takes the asking window’s tab on the app first', () => {
    expect(findAppTab(figma, [figma], 't1', where)).toEqual({ win: windows[0], tabId: 't2' })
    expect(findAppTab(figma, [figma], null, where)).toEqual({ win: windows[0], tabId: 't2' })
  })

  it('keeps to its own address when another app shares the site', () => {
    const inbox0 = app('https://mail.google.com/mail/u/0/')
    const inbox1 = app('https://mail.google.com/mail/u/1/')
    expect(findAppTab(inbox0, [inbox0, inbox1], null, where)).toBeNull()
    expect(findAppTab(inbox1, [inbox0, inbox1], null, where)).toEqual({ win: windows[1], tabId: 't4' })
  })
})

describe('WebAppStore', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'apex-web-apps-'))

  it('saves, renames, opens and removes apps, and keeps them across launches', () => {
    const d = dir()
    const changes = vi.fn()
    const store = new WebAppStore(d, changes, () => NOW)
    const added = store.add({ name: ' Linear ', url: 'https://linear.app/team#top', icon: 'data:image/png;base64,AA==' })
    expect(added).toMatchObject({ name: 'Linear', url: 'https://linear.app/team', icon: 'data:image/png;base64,AA==', addedAt: NOW, lastOpenedAt: null })
    expect(store.add({ name: 'Again', url: 'https://linear.app/team', icon: null })).toBe(added)
    expect(store.byUrl('https://linear.app/team#other')?.id).toBe(added.id)
    expect(store.rename(added.id, '  ').name).toBe('Linear')
    expect(store.rename(added.id, 'Issues').name).toBe('Issues')
    store.touch(added.id)
    expect(new WebAppStore(d).list()).toEqual([{ ...added, name: 'Issues', lastOpenedAt: NOW }])
    store.remove(added.id)
    expect(store.list()).toEqual([])
    expect(changes).toHaveBeenCalledTimes(4)
  })

  it('refuses addresses that aren’t websites and drops oversized icons', () => {
    const store = new WebAppStore(dir())
    expect(() => store.add({ name: 'Workspace', url: 'apex://workspace', icon: null })).toThrow()
    expect(store.add({ name: 'Big', url: 'https://big.example.com/', icon: 'x'.repeat(WEB_APP_LIMITS.icon * 2 + 1) }).icon).toBeNull()
  })

  it('starts empty from an unreadable file and leaves it until the next save', () => {
    const d = dir()
    writeFileSync(join(d, WEB_APPS_FILE), '{"version":1,"apps":[{"id":1}]}')
    const store = new WebAppStore(d)
    expect(store.list()).toEqual([])
    expect(readFileSync(join(d, WEB_APPS_FILE), 'utf8')).toContain('"id":1')
  })
})
