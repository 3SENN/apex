/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { ChatSummary } from '@shared/chats'
import { UI, type MenuCommand } from '@shared/ipc'
import type { SettingsStore } from './settings'
import type { BaseCheckState } from './smokeBase'
import { captureWindow, sleep, type Chrome } from './smokeKit'
import type { BookmarkStore } from './stores'
import type { Tab, TabManager } from './tabs'

// The design scene, shot at the design window size (1470×923) so its
// geometry compares one to one with docs/design-spec.md:
// the companion card over a chat page with chats and tabs in the sidebar,
// the breadcrumb pill and the bookmarks bar; the same chat page alone; an
// empty chat as a page and in the panel; and close-ups of the sidebar rows.

export interface SceneDeps {
  chrome: Chrome
  tabs: TabManager
  settings: SettingsStore
  bookmarks: BookmarkStore
  /** The fixture web page's tab. */
  first: Tab
  base: string
  baseState: BaseCheckState
  dir: string
}

/** The design window's content size (CSS px). */
const SCENE = { width: 1470, height: 923 }

/** A few bookmarks, so the bar has a row of items. */
function seedBookmarks(bookmarks: BookmarkStore, base: string): void {
  const items: Array<[string, string]> = [
    [`${base}?b=reading`, 'Reading list'],
    [`${base}?b=recipes`, 'Weeknight recipes'],
    ['https://example.com/', 'Example Domain'],
    [`${base}second?b=trip`, 'Trip planning'],
    [`${base}?b=garden`, 'Garden notes'],
  ]
  for (const [url, title] of items) if (!bookmarks.findByUrl(url)) bookmarks.toggle(url, title)
}

export async function captureScene({ chrome, tabs, settings, bookmarks, first, base, baseState, dir }: SceneDeps): Promise<string[]> {
  const ui = chrome.ui
  const window = BrowserWindow.fromWebContents(ui)
  const written: string[] = []
  const command = (c: MenuCommand): void => ui.send(UI.command, c)
  const shoot = async (name: string, wait = 500): Promise<void> => {
    await sleep(wait)
    writeFileSync(`${dir}/${name}.png`, (await captureWindow(ui, tabs)).toPNG())
    written.push(`${name}.png`)
  }
  // The sidebar has no native views over it, so it is captured straight from the chrome at device resolution.
  const shootSidebar = async (name: string, height: number, wait = 300): Promise<void> => {
    await sleep(wait)
    const width = await chrome.js<number>(`return Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 300)`)
    const image = await ui.capturePage({ x: 0, y: 0, width, height })
    writeFileSync(`${dir}/${name}.png`, image.toPNG())
    written.push(`${name}.png`)
  }
  const pointAt = (x: number, y: number): void => ui.sendInputEvent({ type: 'mouseMove', x, y })
  const panelShown = `document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel')`

  const before = { size: window?.getContentSize() ?? [1440, 900], bar: settings.get().bookmarksBar }
  seedBookmarks(bookmarks, base)
  settings.update({ bookmarksBar: 'always' })
  window?.setContentSize(SCENE.width, SCENE.height)
  try {
    // Close the panel if something left it open: the design scene has none.
    if (await chrome.js<boolean>(`return Boolean(${panelShown})`)) {
      command('toggle-agent')
      await chrome.until(`return !${panelShown}`, 3000, 'the panel to close')
    }
    // ---- a chat page, with the card over it ----
    const chatId = baseState.picnicChatId ?? baseState.laptopChatId
    if (chatId) {
      const tab = tabs.create(`apex://chat/${chatId}`)
      await chrome.until(`return document.querySelector('.chat-view--page .chat-log') && document.querySelector('.bookmarks-bar, .bm-bar, [aria-label="Bookmarks"]')`, 8000, 'the chat page and bookmarks bar')
      pointAt(SCENE.width - 40, SCENE.height - 40)
      await shoot('scene-chat', 1200)
      await chrome.click(/open profile$/, `document.querySelector('.chat-view--page .chat-chip-header')`)
      await chrome.until(`return document.querySelector('.co-card .companion__live[data-ready]')`, 15_000, 'the card’s live figure')
      await shoot('scene-card', 1500)
      await chrome.escape()
      await chrome.until(`return !document.querySelector('.co-card')`, 3000, 'the card to close')

      // ---- the sidebar rows, close up: at rest, then with the pointer over a chat row (stamps and close) ----
      await shootSidebar('sidebar-rows', 560)
      const row = await chrome.js<{ x: number; y: number } | null>(
        `const r = document.querySelector('.sidebar .chat-row:not(.side-row--active)')?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null`,
      )
      if (row) {
        pointAt(row.x, row.y)
        await shootSidebar('sidebar-rows-hover', 560, 500)
      }
      pointAt(SCENE.width - 40, SCENE.height - 40)
      tabs.close(tab.id)
    }

    // ---- an empty chat, as a page ----
    const draft = await chrome.invoke<ChatSummary>('chats', 'create', {})
    const empty = tabs.create(`apex://chat/${draft.id}`)
    await chrome.until(`return document.querySelector('.chat-view--page.chat-view--empty .companion__live[data-ready]')`, 15_000, 'the waiting companion on the page')
    await shoot('chat-empty-page', 1200)
    tabs.close(empty.id)

    // ---- an empty chat, in the panel beside a website ----
    tabs.activate(first.id)
    command('new-chat')
    await chrome.until(`return document.querySelector('.chat-view--panel.chat-view--empty .companion__live[data-ready]')`, 15_000, 'the waiting companion in the panel')
    await shoot('chat-empty-panel', 1200)
    command('toggle-agent')
    await chrome.until(`return !${panelShown}`, 3000, 'the panel to close')
  } finally {
    settings.update({ bookmarksBar: before.bar })
    window?.setContentSize(before.size[0] ?? 1440, before.size[1] ?? 900)
    await sleep(300)
  }
  return written
}
