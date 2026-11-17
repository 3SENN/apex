/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import type { ChatSummary } from '@shared/chats'
import type { Companion } from '@shared/companion'
import type { SettingsView, TabsSnapshot, WindowState } from '@shared/ipc'
import type { Bookmark, DownloadInfo, Routine } from '@shared/services'
import { apex, call } from '../../../api'

// What the revealed sidebar needs, loaded in the overlay renderer itself
// (it has no App around it): the window's tabs, settings, chats, companions,
// routines, bookmarks and downloads, kept live from the same events.

export interface ShellData {
  snapshot: TabsSnapshot
  settings: SettingsView
  windowState: WindowState
  chats: ChatSummary[] | null
  companions: { list: Companion[]; activeId: string }
  routines: Routine[]
  bookmarks: Bookmark[]
  downloads: DownloadInfo[]
}

// Main sends the window's tabs here only while a revealed sidebar is open, the first just before it
// shows, so the latest is kept for the next sidebar to start from (the initial state is from load).
let latestTabs: TabsSnapshot = apex.initial.tabs
apex.tabs.onChanged((next) => {
  latestTabs = next
})

export function useShellData(): ShellData {
  const [snapshot, setSnapshot] = useState<TabsSnapshot>(() => latestTabs)
  const [settings, setSettings] = useState<SettingsView>(apex.initial.settings)
  const [windowState, setWindowState] = useState<WindowState>(apex.initial.window)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [companions, setCompanions] = useState<{ list: Companion[]; activeId: string }>({ list: [], activeId: '' })
  const [routines, setRoutines] = useState<Routine[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [downloads, setDownloads] = useState<DownloadInfo[]>([])
  useEffect(() => {
    const offs = [
      apex.tabs.onChanged(setSnapshot),
      apex.onAppEvent((event) => {
        if (event.type === 'settings') setSettings(event.view)
        else if (event.type === 'window') setWindowState(event.state)
        else if (event.type === 'chats') setChats(event.items)
        else if (event.type === 'companions') setCompanions({ list: event.items, activeId: event.activeId })
        else if (event.type === 'routines') setRoutines(event.items)
        else if (event.type === 'bookmarks') setBookmarks(event.items)
        else if (event.type === 'downloads') setDownloads(event.items)
      }),
    ]
    const keep = <T,>(set: (v: T) => void) => (v: T): void => set(v)
    const quiet = (): void => undefined
    void apex.settings.get().then(keep(setSettings), quiet)
    void call('window', 'state').then(keep(setWindowState), quiet)
    void call('chats', 'list', { limit: 1000 }).then((list) => setChats((c) => c ?? list), () => setChats((c) => c ?? []))
    void Promise.all([call('companions', 'list'), call('companions', 'activeId')]).then(([list, activeId]) => setCompanions({ list, activeId }), quiet)
    void call('routines', 'list').then(keep(setRoutines), quiet)
    void call('bookmarks', 'list').then(keep(setBookmarks), quiet)
    void call('downloads', 'list').then(keep(setDownloads), quiet)
    return () => offs.forEach((off) => off())
  }, [])
  return { snapshot, settings, windowState, chats, companions, routines, bookmarks, downloads }
}
