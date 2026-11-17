/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsView } from '@shared/ipc'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import { BookmarkStore, bookmarkStore, setProfileBookmarkStores } from '../src/main/bookmarks'
import { DownloadManager, downloadManager, setProfileDownloadManagers, type DownloadDeps } from '../src/main/downloads'
import { eventForProfile, profileThemeState, runInProfile, scopedInstance, scopedProfile, scopeNamespaces } from '../src/main/profiles/scope'

// SH-64 regressions: a profile's theme, accent and stores are its own, not
// the default profile's. No Electron windows, no network.

const temp = (): string => mkdtempSync(join(tmpdir(), 'apex-profile-scope-'))

describe('profile scope', () => {
  it('carries the profile through async work and leaves the default outside it', async () => {
    expect(scopedProfile()).toBeUndefined()
    const seen = await runInProfile('work', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return scopedProfile()
    })
    expect(seen).toBe('work')
    expect(scopedProfile()).toBeUndefined()
    // The default profile keeps the default instance.
    expect(runInProfile(DEFAULT_PROFILE_ID, () => scopedInstance(() => 'own'))).toBeNull()
    expect(runInProfile('work', () => scopedInstance((id) => `own-${id}`))).toBe('own-work')
  })

  it('wraps only the named namespaces', async () => {
    const services = { bookmarks: { list: () => scopedProfile(), later: async () => scopedProfile() }, chats: { list: () => scopedProfile() } }
    const scoped = scopeNamespaces(services, ['bookmarks'], 'work')
    expect(scoped.bookmarks!.list()).toBe('work')
    expect(await scoped.bookmarks!.later()).toBe('work')
    expect(scoped.chats).toBeUndefined()
  })
})

describe('profile theme (SH-64)', () => {
  it('uses the profile’s own preference and accent', () => {
    expect(profileThemeState({ theme: 'dark', accent: 'ocean' }, 'light', '#123456')).toEqual({ preference: 'dark', mode: 'dark', accentChoice: 'ocean', accent: '#2f6bff' })
    expect(profileThemeState({ theme: 'system', accent: 'companion' }, 'dark', '#123456')).toEqual({ preference: 'system', mode: 'dark', accentChoice: 'companion', accent: '#123456' })
  })

  it('turns app-wide events into each window’s profile view', () => {
    const source = {
      theme: (id: string) => profileThemeState(id === 'work' ? { theme: 'dark', accent: 'ocean' } : { theme: 'light', accent: 'companion' }, 'light', '#123456'),
      settings: (id: string) => ({ profile: id }) as unknown as SettingsView,
    }
    const front = { type: 'theme', theme: source.theme(DEFAULT_PROFILE_ID) } as const
    expect(eventForProfile(front, 'work', source)).toEqual({ type: 'theme', theme: source.theme('work') })
    expect(eventForProfile(front, DEFAULT_PROFILE_ID, source)).toEqual(front)
    const settings = { type: 'settings', view: source.settings(DEFAULT_PROFILE_ID) } as const
    expect(eventForProfile(settings, 'work', source)).toEqual({ type: 'settings', view: { profile: 'work' } })
    // The default profile's lists stay with its windows.
    expect(eventForProfile({ type: 'bookmarks', items: [] }, 'work', source)).toBeNull()
    expect(eventForProfile({ type: 'downloads', items: [] }, 'work', source)).toBeNull()
    expect(eventForProfile({ type: 'bookmarks', items: [] }, DEFAULT_PROFILE_ID, source)).toEqual({ type: 'bookmarks', items: [] })
    expect(eventForProfile({ type: 'chats', items: [] }, 'work', source)).toEqual({ type: 'chats', items: [] })
  })
})

describe('per-profile bookmarks (SH-64)', () => {
  afterEach(() => setProfileBookmarkStores(null))

  it('keeps another profile’s store apart from the default one', () => {
    const root = new BookmarkStore(temp())
    const work = new BookmarkStore(temp(), { profile: true })
    // Making a profile's store never replaces the default one.
    expect(bookmarkStore()).toBe(root)
    setProfileBookmarkStores((id) => (id === 'work' ? work : null))
    runInProfile('work', () => bookmarkStore()!.toggle('https://example.com/', 'Example'))
    expect(work.list().map((b) => b.url)).toEqual(['https://example.com/'])
    expect(root.list()).toEqual([])
    expect(runInProfile(DEFAULT_PROFILE_ID, () => bookmarkStore())).toBe(root)
  })
})

class FakeItem extends EventEmitter {
  savePath = ''
  constructor(readonly name: string) {
    super()
  }
  getFilename = (): string => this.name
  getURL = (): string => `https://files.example.com/${this.name}`
  getMimeType = (): string => 'application/octet-stream'
  getTotalBytes = (): number => 10
  getReceivedBytes = (): number => 0
  setSavePath = (path: string): void => void (this.savePath = path)
  isPaused = (): boolean => false
  canResume = (): boolean => false
  resume = (): void => undefined
  cancel = (): void => void this.emit('done', {}, 'cancelled')
}

class FakeSession extends EventEmitter {
  downloadURL = vi.fn()
}

describe('per-profile downloads (SH-64)', () => {
  afterEach(() => setProfileDownloadManagers(null))

  it('lists a profile session’s downloads in its own manager only', () => {
    const deps: Partial<DownloadDeps> = {
      prefs: () => ({ downloadDir: null, askWhereToSave: false }),
      origin: () => ({ tabId: null, byAgent: false, windowId: null }),
      classify: () => 'none',
      broadcast: () => undefined,
      notify: () => undefined,
      appFocused: () => true,
    }
    const folder = join(temp(), 'Downloads')
    mkdirSync(folder)
    const root = new DownloadManager(new FakeSession() as unknown as Session, temp(), folder, deps)
    const workSession = new FakeSession()
    const work = new DownloadManager(workSession as unknown as Session, temp(), folder, deps, { profile: true })
    expect(downloadManager()).toBe(root)
    // The features' session hook attaches the default manager to every session; the owner keeps its own.
    root.attach(workSession as unknown as Session, false)
    workSession.emit('will-download', {}, new FakeItem('report.pdf'), null)
    expect(work.list().map((d) => d.filename)).toEqual(['report.pdf'])
    expect(root.list()).toEqual([])
    setProfileDownloadManagers((id) => (id === 'work' ? work : null))
    expect(runInProfile('work', () => downloadManager())).toBe(work)
    expect(downloadManager()).toBe(root)
  })
})
