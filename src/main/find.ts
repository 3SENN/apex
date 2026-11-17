/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CLOSED_FIND, findSeed, type FindState } from '@shared/find'
import type { WindowContext } from './features/types'
import type { Tab } from './tabs'

// Find in page (SH-44): each tab's open state, query and matches live
// here, so the bar comes back as it was after a tab switch. Typing is
// debounced in the bar; ⌘G and ⇧⌘G step from anywhere. Closing keeps the
// active match selected.

export interface FindController {
  open(tabId: string): Promise<FindState>
  query(tabId: string, text: string): FindState
  step(tabId: string, forward: boolean): Promise<FindState>
  close(tabId: string): void
  state(tabId: string): FindState
  /** Wires one tab's events; returns the cleanup. */
  attach(tab: Tab, win: WindowContext): () => void
}

export interface FindDeps {
  windows(): readonly WindowContext[]
  /** Hears every state change (the find-bar surface closes with it). */
  onState?(tabId: string, win: WindowContext | null, state: FindState): void
}

// Reads the selection in the page's isolated world (the page's own scripts
// never see it), and never from a password field.
const SELECTION_SCRIPT = `(() => {
  const el = document.activeElement
  const password = !!el && el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password'
  let text = ''
  if (!password && el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number') text = String(el.value).slice(el.selectionStart, el.selectionEnd)
  else if (!password) text = String(window.getSelection() || '')
  return { text: text.slice(0, 4000), password }
})()`

export function createFind(deps: FindDeps): FindController {
  const states = new Map<string, FindState>()

  const locate = (tabId: string): { tab: Tab; win: WindowContext } | null => {
    for (const win of deps.windows()) {
      const tab = win.tabs.find(tabId)
      if (tab) return { tab, win }
    }
    return null
  }
  const get = (tabId: string): FindState => states.get(tabId) ?? CLOSED_FIND
  const publish = (tabId: string, win: WindowContext | null, next: FindState): FindState => {
    states.set(tabId, next)
    win?.send({ type: 'find-state', tabId, state: next })
    deps.onState?.(tabId, win, next)
    return next
  }
  const usable = (tab: Tab, win: WindowContext): boolean => !tab.view.webContents.isDestroyed() && !win.tabs.isChromeDrawn(tab)

  const search = (tab: Tab, win: WindowContext, text: string, forward: boolean, newSession: boolean): FindState => {
    const state = get(tab.id)
    if (!text) {
      if (usable(tab, win)) tab.view.webContents.stopFindInPage('clearSelection')
      return publish(tab.id, win, { ...state, query: '', matches: 0, active: 0, searching: false })
    }
    if (!usable(tab, win)) return publish(tab.id, win, { ...state, query: text, matches: 0, active: 0, searching: false })
    // Electron's findNext starts a new session when true.
    tab.view.webContents.findInPage(text, { forward, findNext: newSession })
    return publish(tab.id, win, { ...state, query: text, searching: true })
  }

  const seed = async (tab: Tab): Promise<string> => {
    try {
      const result = (await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: SELECTION_SCRIPT }])) as { text?: unknown; password?: unknown } | null
      return findSeed(typeof result?.text === 'string' ? result.text : '', result?.password === true)
    } catch {
      return ''
    }
  }

  const controller: FindController = {
    async open(tabId) {
      const found = locate(tabId)
      if (!found) throw new Error('That tab is closed.')
      const { tab, win } = found
      const state = get(tabId)
      const seeded = usable(tab, win) ? await seed(tab) : ''
      const query = seeded || state.query
      publish(tabId, win, { ...state, open: true })
      if (query && (query !== state.query || state.matches === 0)) return search(tab, win, query, true, true)
      return get(tabId)
    },
    query(tabId, text) {
      const found = locate(tabId)
      if (!found) throw new Error('That tab is closed.')
      const next = { ...get(tabId), open: true }
      states.set(tabId, next)
      return search(found.tab, found.win, text, true, true)
    },
    async step(tabId, forward) {
      const found = locate(tabId)
      if (!found) throw new Error('That tab is closed.')
      const state = get(tabId)
      // ⌘G with nothing to find opens the bar instead.
      if (!state.query) return controller.open(tabId)
      if (!state.open) publish(tabId, found.win, { ...state, open: true })
      return search(found.tab, found.win, state.query, forward, state.matches === 0)
    },
    close(tabId) {
      const found = locate(tabId)
      if (found && usable(found.tab, found.win)) found.tab.view.webContents.stopFindInPage('keepSelection')
      publish(tabId, found?.win ?? null, { ...get(tabId), open: false, searching: false })
    },
    state: get,
    attach(tab, win) {
      const wc = tab.view.webContents
      const onFound = (_e: unknown, result: Electron.Result): void => {
        if (!result.finalUpdate) return
        const state = get(tab.id)
        publish(tab.id, win, { ...state, matches: result.matches, active: result.activeMatchOrdinal, searching: false })
      }
      // A new page has new matches: search it again while the bar is open.
      const onLoaded = (): void => {
        const state = get(tab.id)
        if (state.open && state.query) search(tab, win, state.query, true, true)
        else if (state.matches > 0) publish(tab.id, win, { ...state, matches: 0, active: 0 })
      }
      wc.on('found-in-page', onFound)
      wc.on('did-finish-load', onLoaded)
      return () => {
        states.delete(tab.id)
        if (!wc.isDestroyed()) {
          wc.off('found-in-page', onFound)
          wc.off('did-finish-load', onLoaded)
        }
      }
    },
  }
  return controller
}
