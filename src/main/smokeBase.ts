/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Menu, type MenuItem } from 'electron'
import type { ChatSummary } from '@shared/chats'
import type { Companion, CompanionPreset } from '@shared/companion'
import type { AgentHost } from './agent/host'
import type { ChatStore } from './chats'
import { SettingsStore } from './settings'
import type { SmokeClient } from './smokeClient'
import { assert, sleep, waitFor, type Chrome } from './smokeKit'
import type { BookmarkStore } from './stores'
import type { Tab, TabManager } from './tabs'

// Base checks: chats with their own sessions, several companions, the
// settings migration, the live theme, the sidebar and its tab order, and
// ⌘D. They also leave the state the screenshot tour shows (chats, a second
// companion, pinned tabs, a bookmark).

export interface BaseCheckDeps {
  chrome: Chrome
  tabs: TabManager
  host: AgentHost
  client: SmokeClient
  chats: ChatStore
  settings: SettingsStore
  bookmarks: BookmarkStore
  /** The fixture server's root URL. */
  base: string
}

/** What the checks leave behind for the screenshot tour. */
export interface BaseCheckState {
  /** Started from the new tab page; shown in the panel. */
  picnicChatId: string | null
  laptopChatId: string | null
  /** Still working (its reply is held) until release(). */
  runningChatId: string | null
  /** A second, inactive companion. */
  otherCompanionId: string | null
  pinnedTabIds: string[]
}

type Check = (name: string, fn: () => Promise<string>) => Promise<void>

function findMenuItem(items: readonly MenuItem[], match: (item: MenuItem) => boolean): MenuItem | null {
  for (const item of items) {
    if (match(item)) return item
    const inner = item.submenu ? findMenuItem(item.submenu.items, match) : null
    if (inner) return inner
  }
  return null
}

async function waitLoaded(tab: Tab): Promise<void> {
  await waitFor(() => !tab.view.webContents.isLoading() && tab.view.webContents.getURL() !== '', 10_000, 'a page to load')
}

const userTexts = (log: Array<{ type: string; text?: string }>): string[] => log.filter((e) => e.type === 'user-message').map((e) => e.text ?? '')

export async function runBaseChecks(deps: BaseCheckDeps, check: Check): Promise<BaseCheckState> {
  const { chrome, tabs, host, client, chats, settings, bookmarks, base } = deps
  const state: BaseCheckState = { picnicChatId: null, laptopChatId: null, runningChatId: null, otherCompanionId: null, pinnedTabIds: [] }
  const summary = (id: string): ChatSummary | undefined => chats.summary(id)
  const settled = (id: string): boolean => !host.isRunning(id) && ['finished', 'error', 'idle'].includes(summary(id)?.status ?? '')

  await check('settings saved by an older Atelier are migrated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atelier-smoke-settings-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ showBookmarksBar: false, layout: 'ribbon', sidebarWidth: 9999, theme: 'dark', onboarded: true }))
    const migrated = new SettingsStore(dir).get()
    assert(migrated.bookmarksBar === 'never', `bookmarksBar is ${migrated.bookmarksBar}`)
    assert(!('showBookmarksBar' in migrated), 'the old field is still there')
    assert(migrated.layout === 'sidebar', `an unknown layout became ${migrated.layout}`)
    assert(migrated.sidebarWidth === 360, `the width was not clamped: ${migrated.sidebarWidth}`)
    assert(migrated.theme === 'dark' && migrated.onboarded, 'valid fields were not kept')
    return 'bookmarks bar off → never, bad layout → sidebar, width clamped, the rest kept'
  })

  await check('the theme switch updates data-theme live', async () => {
    const original = settings.get().theme
    const backgrounds: Record<string, string> = {}
    try {
      for (const mode of ['dark', 'light'] as const) {
        settings.update({ theme: mode })
        // The tokens key off data-theme, so the page background must change with it.
        backgrounds[mode] = await chrome.until<string>(
          `const d = document.documentElement.dataset; return d.theme === '${mode}' && d.themePref === '${mode}' && getComputedStyle(document.querySelector('.app') ?? document.body).backgroundColor`,
          5000,
          `data-theme="${mode}"`,
        )
      }
      assert(backgrounds.dark !== backgrounds.light, `the background did not change: ${backgrounds.dark}`)
    } finally {
      settings.update({ theme: original })
    }
    await chrome.until(`return document.documentElement.dataset.themePref === '${original}'`, 5000, 'the theme to be restored')
    return `dark ${backgrounds.dark} → light ${backgrounds.light}, back to ${original}`
  })

  await check('companions: create, switch, and the last one is kept', async () => {
    const firstId = await chrome.invoke<string>('companions', 'activeId')
    const presets = await chrome.invoke<CompanionPreset[]>('companion', 'presets')
    const preset = presets[1] ?? presets[0]
    assert(preset, 'no presets')
    const made = await chrome.invoke<Companion>('companions', 'create', { presetId: preset.id })
    assert((await chrome.invoke<string>('companions', 'activeId')) === made.id, 'a new companion should become active')
    // The chrome follows the switch (the toolbar has no companion control any more, DS-24).
    await chrome.until(`return document.querySelector('.app')?.dataset.activeCompanion === ${JSON.stringify(made.id)}`, 5000, 'the chrome to follow the new companion')
    await chrome.invoke('companions', 'setActive', firstId)
    await chrome.invoke('companions', 'remove', made.id)
    const left = await chrome.invoke<Companion[]>('companions', 'list')
    assert(left.length === 1 && left[0]?.id === firstId, `expected only the first companion, got ${left.map((c) => c.name).join(', ')}`)
    const refusedDelete = await chrome.invoke('companions', 'remove', firstId).then(() => null, (err: unknown) => (err as Error).message)
    assert(refusedDelete, 'deleting the last companion went through')
    const refusedHide = await chrome.invoke('companions', 'hide', firstId).then(() => null, (err: unknown) => (err as Error).message)
    assert(refusedHide, 'hiding the last companion went through')
    // Leave a second companion for the card's previous/next and the new tab picker.
    const other = await chrome.invoke<Companion>('companions', 'create', { presetId: preset.id, activate: false })
    assert((await chrome.invoke<string>('companions', 'activeId')) === firstId, 'activate: false still switched')
    state.otherCompanionId = other.id
    return `made ${made.name}, switched back, deleted it; refused: “${refusedDelete}”`
  })

  await check('a chat asked on the new tab page takes over that tab', async () => {
    const tab = tabs.create('about:blank')
    // The start composer (DS-74): a textarea with a round send button.
    await chrome.until(`return document.querySelector('.nt-composer__field:not([disabled])')`, 8000, 'the new tab page')
    await chrome.type('.nt-composer__field', 'Plan a picnic for Saturday')
    await chrome.click(/^Send$/, `document.querySelector('.nt-composer')`)
    // The same tab becomes the chat page, and the reply arrives there.
    await waitFor(() => /^atelier:\/\/chat\//.test(tab.internalUrl ?? ''), 10_000, 'the tab to become the chat page')
    await chrome.until(
      `const view = document.querySelector('.chat-view--page'); return view && view.textContent.includes('Plan a picnic for Saturday') && view.textContent.includes('Should I check the weather') && 'ok'`,
      10_000,
      'the chat page to show the message and its reply',
    )
    const id = chats.list().find((c) => c.title.startsWith('Plan a picnic'))?.id
    assert(id, 'the chat was not saved')
    assert(tab.internalUrl === `atelier://chat/${id}`, `the tab shows ${tab.internalUrl}`)
    assert(tabs.activeId() === tab.id, 'another tab took focus')
    await waitFor(() => settled(id), 5000, 'the chat to finish')
    state.picnicChatId = id
    return `chat ${id.slice(0, 8)} answered in its own tab`
  })

  await check('two chats run in separate sessions with separate logs', async () => {
    const before = client.requests
    const laptops = host.start('Compare two laptops for travel')
    // Hold only the second chat's reply: wait until the first one has asked.
    await waitFor(() => client.requests > before, 5000, 'the first chat to send')
    client.hold()
    const running = host.start('Summarize what I have open')
    await waitFor(() => client.requests > before + 1, 5000, 'the second chat to send')
    await waitFor(() => settled(laptops), 5000, 'the laptop chat to finish')
    assert(host.isRunning(running), 'the held chat should still be working')
    const a = state.picnicChatId ? host.view(state.picnicChatId) : null
    const b = host.view(laptops)
    const c = host.view(running)
    assert(a && userTexts(a.log).join('|') === 'Plan a picnic for Saturday', `picnic log: ${userTexts(a?.log ?? []).join('|')}`)
    assert(userTexts(b.log).join('|') === 'Compare two laptops for travel', `laptop log: ${userTexts(b.log).join('|')}`)
    assert(userTexts(c.log).join('|') === 'Summarize what I have open', `running log: ${userTexts(c.log).join('|')}`)
    assert(!JSON.stringify(b.log).includes('picnic') && !JSON.stringify(a.log).includes('laptop'), 'logs leaked into each other')
    assert(new Set([a.summary.id, b.summary.id, c.summary.id]).size === 3, 'chats share an id')
    assert(summary(running)?.status === 'running' && summary(laptops)?.status === 'finished', `statuses: ${summary(running)?.status}, ${summary(laptops)?.status}`)
    // Every request went to the offline stand-in.
    assert(client.requests - before >= 2, 'the stand-in client was not used')
    state.laptopChatId = laptops
    state.runningChatId = running
    return `3 chats, 3 logs; one still working while another finished`
  })

  await check('the sidebar shows pinned tabs, tabs and chats', async () => {
    // Two pinned tabs for the favicon grid.
    for (const path of ['?pinned=1', 'second?pinned=2']) {
      const tab = tabs.create(`${base}${path}`, { activate: false })
      tabs.setPinned(tab.id, true)
      state.pinnedTabIds.push(tab.id)
    }
    const expectTitles = ['Plan a picnic', 'Compare two laptops', 'Summarize what I have open']
    const seen = await chrome.until<{ chats: string[]; tabs: number; pinned: number }>(
      `const chats = [...document.querySelectorAll('.sidebar .chats-section .chat-row')].map((r) => r.textContent.trim())
       const pinned = document.querySelectorAll('.sidebar .pin-grid [data-tab-ids]').length
       const rows = document.querySelectorAll('.sidebar .tabs-section .tab-row').length
       return ${JSON.stringify(expectTitles)}.every((t) => chats.some((c) => c.includes(t))) && pinned === 2 && rows > 0 && { chats, tabs: rows, pinned }`,
      8000,
      'the sidebar to list the chats and tabs',
    )
    const unpinned = tabs.all().filter((t) => !t.pinned).length
    assert(seen.tabs <= unpinned, `${seen.tabs} tab rows for ${unpinned} tabs`)
    return `${seen.pinned} pinned, ${seen.tabs} tab rows, ${seen.chats.length} chat rows`
  })

  await check('destinations open on their own surface, not as tabs (DS-99)', async () => {
    const before = tabs.all().length
    const active = tabs.activeId()
    assert(active, 'no active tab')
    tabs.openInternal('atelier://chats')
    const shown = await chrome.until<{ activeRows: number; dest: string }>(
      `const page = document.querySelector('.pane--rail .chats-page')
       const dest = document.querySelector('.sidebar .dest-row.side-row--active')
       const activeRows = document.querySelectorAll('.sidebar .tab-row.side-row--active, .sidebar .chat-row.side-row--active').length
       return page && dest && { activeRows, dest: dest.textContent.trim() }`,
      6000,
      'All chats on the destination surface',
    )
    assert(tabs.all().length === before, `opening All chats changed the tab count (${before} → ${tabs.all().length})`)
    assert(tabs.activeId() === active && tabs.snapshot().rail?.url === 'atelier://chats', 'the rail is not set')
    assert(shown.activeRows === 0, `${shown.activeRows} tab or chat rows are still active`)
    tabs.activate(active)
    await chrome.until(`return !document.querySelector('.pane--rail')`, 4000, 'the tab to come back')
    assert(tabs.snapshot().rail === null, 'activating a tab did not leave the destination')
    return `${shown.dest} on its own surface; ${before} tabs before and after`
  })

  await check('the tab shortcuts follow the sidebar order', async () => {
    const domOrder = (): Promise<string[]> => chrome.js<string[]>(`return [...document.querySelectorAll('.sidebar [data-tab-ids]')].flatMap((el) => el.dataset.tabIds.split(' '))`)
    const mainOrder = (): string[] => tabs.visibleOrder().filter((e) => e.kind === 'tab').map((e) => e.id)
    const extra = tabs.create(`${base}second?order=1`, { activate: false })
    await waitFor(async () => JSON.stringify(await domOrder()) === JSON.stringify(mainOrder()) && (await domOrder()).includes(extra.id), 5000, 'the sidebar order to reach main')
    // Move the last tab to the top of the unpinned block; the sidebar and the shortcuts follow.
    const unpinned = tabs.all().filter((t) => !t.pinned)
    const last = unpinned[unpinned.length - 1]
    assert(last, 'no unpinned tabs')
    tabs.move(last.id, tabs.all().filter((t) => t.pinned).length)
    await waitFor(async () => {
      const dom = await domOrder()
      return dom[state.pinnedTabIds.length] === last.id && JSON.stringify(dom) === JSON.stringify(mainOrder())
    }, 5000, 'the moved tab to lead the list')
    const index = tabs.visibleOrder().findIndex((e) => e.kind === 'tab' && e.id === last.id)
    assert(index >= 0 && index < 8, `the moved tab is entry ${index}`)
    const previous = tabs.activeId()
    tabs.selectNth(index)
    assert(tabs.activeId() === last.id, `⌘${index + 1} activated ${tabs.activeId()} instead of ${last.id}`)
    if (previous) tabs.activate(previous)
    tabs.close(extra.id)
    return `⌘${index + 1} → ${last.id}; order ${mainOrder().join(', ')}`
  })

  await check('⌘D only adds a bookmark', async () => {
    const tab = tabs.create(`${base}second?bookmark=1`)
    await waitLoaded(tab)
    const url = tab.view.webContents.getURL()
    // macOS menus spell it Cmd+D, other platforms Ctrl+D (shortcuts.ts).
    const item = findMenuItem(Menu.getApplicationMenu()?.items ?? [], (i) => /^(CmdOrCtrl|Cmd|Command|Ctrl)\+D$/.test(i.accelerator ?? ''))
    assert(item, 'no ⌘D menu item')
    // ⌘D adds the page, then opens the bookmark editor beside the star.
    item.click()
    await waitFor(() => !!bookmarks.findByUrl(url), 5000, 'the first ⌘D to add')
    item.click()
    await sleep(300)
    await chrome.escape().catch(() => undefined)
    assert(bookmarks.findByUrl(url), 'the second ⌘D removed the bookmark')
    assert(bookmarks.list().filter((b) => b.url === url).length === 1, 'the bookmark was added twice')
    tabs.close(tab.id)
    return 'added once, kept on the second press'
  })

  return state
}
