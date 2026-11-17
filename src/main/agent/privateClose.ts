/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// CH-30: closing a tab (or a window) that holds a private chat with
// something in it asks first, with the same question ending the chat asks
// (ChatBanners's discardPrivateChat); an empty private chat closes without
// asking. Once the person agrees, the tab closes and the chat is discarded.
// A chat still shown somewhere else (another tab, the side panel) isn't
// ending, so nothing is asked. Every way a tab closes goes through
// TabManager.close (the close button, ⌘W, middle-click, close others/below/
// all, a group), so one guard there covers them; the window's close guard in
// app.ts asks through windowEnding() (its tabs, and its side panel and details
// views, which main knows per window), and quitting asks once, for every
// window, through privateQuitGate().
import { confirmSpec } from '@shared/dialogLogic'
import type { DialogSpec } from '@shared/dialogs'
import type { WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { chatIdOf } from '../tabState'
import type { Tab } from '../tabs'

/** What the guard reads of a tab. */
export interface ChatTabLike {
  id: string
  internalUrl: string | null
}

export interface OpenTab extends ChatTabLike {
  windowId: number
}

export interface PrivateCloseDeps {
  /** 'content' for a private chat with something in it, 'empty' for one without, null for any other chat. */
  privateState(chatId: string): 'content' | 'empty' | null
  /** What each surface shows now: 'panel', 'details:<chatId>', and 'page:<tabId>' for a chat page or a chat held beside a website (DS-65). */
  viewing(): Viewing
  /** Every open tab in every window. */
  openTabs(): OpenTab[]
  discard(chatId: string): void
  /** Shows privateCloseSpec() in the window; true when the person agreed. */
  ask(win: WindowContext): Promise<boolean>
}

/** The question: the same one ending a private chat asks, so a press on both shows one dialog. */
export function privateCloseSpec(): DialogSpec {
  const title = mainT('chatTools.private.confirmTitle')
  const message = mainT('chatTools.private.confirmMessage')
  return confirmSpec({
    title,
    message,
    confirmLabel: mainT('chatTools.private.confirm'),
    cancelLabel: mainT('menus.dialog.cancel'),
    destructive: true,
    // The chrome's confirm() uses this key for the same question (queues.ts).
    dedupeKey: `chrome:${title}:${message}`.slice(0, 256),
  })
}

/** [surface, chatId], and the window the surface is in when main knows it (the side panel and details views belong to one window). */
export type ViewingEntry = readonly [surface: string, chatId: string, windowId?: number]
type Viewing = ReadonlyArray<ViewingEntry>

/** The windows closing along with the tabs: some, by id, or every one (quitting). */
export type ClosingWindows = ReadonlySet<number> | 'all'

const NO_WINDOWS: ClosingWindows = new Set<number>()

/** A panel or details view in a closing window goes with it. 'page:<tabId>' surfaces go with their tab instead. */
function closesWith([surface, , windowId]: ViewingEntry, windows: ClosingWindows): boolean {
  if (surface.startsWith('page:')) return false
  return windows === 'all' || (windowId !== undefined && windows.has(windowId))
}

/** The chats a tab holds: its atelier://chat page, or a chat held beside its website (surface 'page:<tabId>'). */
export function chatsOfTab(tab: ChatTabLike, viewing: Viewing): string[] {
  const page = chatIdOf(tab.internalUrl)
  const held = viewing.flatMap(([surface, chatId]) => (surface === `page:${tab.id}` ? [chatId] : []))
  return [...new Set([...(page ? [page] : []), ...held])]
}

/** Whether a chat stays on screen once the closing tabs (and windows) are gone: in another tab, or a side panel or details view that stays. */
export function shownElsewhere(chatId: string, staying: readonly ChatTabLike[], viewing: Viewing, closingWindows: ClosingWindows = NO_WINDOWS): boolean {
  if (staying.some((tab) => chatsOfTab(tab, viewing).includes(chatId))) return true
  // 'page:<tabId>' surfaces belong to tabs, staying (checked above) or closing.
  return viewing.some((entry) => entry[1] === chatId && !entry[0].startsWith('page:') && !closesWith(entry, closingWindows))
}

/**
 * The private chats that end when `closing` tabs (and `closingWindows`, with
 * their side panels) close, by what they hold: `content` ones need asking
 * first, `empty` ones close without a word.
 */
export function privateChatsEnding(
  closing: readonly ChatTabLike[],
  staying: readonly ChatTabLike[],
  deps: Pick<PrivateCloseDeps, 'privateState' | 'viewing'>,
  closingWindows: ClosingWindows = NO_WINDOWS,
): { content: string[]; empty: string[] } {
  const viewing = deps.viewing()
  const ids = new Set([...closing.flatMap((tab) => chatsOfTab(tab, viewing)), ...viewing.flatMap((entry) => (closesWith(entry, closingWindows) ? [entry[1]] : []))])
  const result = { content: [] as string[], empty: [] as string[] }
  for (const id of ids) {
    const state = deps.privateState(id)
    if (state === null || shownElsewhere(id, staying, viewing, closingWindows)) continue
    result[state].push(id)
  }
  return result
}

export class PrivateCloseGuard {
  readonly #deps: PrivateCloseDeps
  /** Tabs whose question is on screen: another press waits for the same answer. */
  readonly #asking = new Set<string>()

  constructor(deps: PrivateCloseDeps) {
    this.#deps = deps
  }

  /** Installs the tab half on a window's tab manager. */
  watch(win: WindowContext): void {
    win.tabs.setCloseGuard((tab, proceed) => this.tabClosing(win, tab, proceed))
  }

  /** TabManager's close guard: true while it asks, and `proceed` closes the tab once the person agrees. */
  tabClosing(win: WindowContext, tab: Pick<Tab, 'id' | 'internalUrl'>, proceed: () => void): boolean {
    const staying = this.#deps.openTabs().filter((t) => t.id !== tab.id)
    const ending = privateChatsEnding([tab], staying, this.#deps)
    if (ending.content.length === 0) {
      // Nothing to lose: the tab closes now and the empty chat goes with it.
      if (ending.empty.length > 0) queueMicrotask(() => this.#end(ending.empty, [tab.id]))
      return false
    }
    if (this.#asking.has(tab.id)) return true
    this.#asking.add(tab.id)
    void this.#deps
      .ask(win)
      .then((ok) => {
        if (!ok) return
        proceed()
        this.#end([...ending.content, ...ending.empty], [tab.id])
      })
      .catch(() => undefined)
      .finally(() => this.#asking.delete(tab.id))
    return true
  }

  /**
   * The window half: null when closing `win` ends no private chat with
   * content, in its tabs or its side panel; otherwise the question to ask,
   * and what to do once the window has closed.
   */
  windowEnding(win: WindowContext): { ask(): Promise<boolean>; end(): void } | null {
    const tabs = this.#deps.openTabs()
    const closing = tabs.filter((t) => t.windowId === win.id)
    const windows = new Set([win.id])
    const ending = privateChatsEnding(
      closing,
      tabs.filter((t) => t.windowId !== win.id),
      this.#deps,
      windows,
    )
    if (ending.content.length === 0) return null
    const ids = closing.map((t) => t.id)
    return {
      ask: () => this.#deps.ask(win),
      end: () => this.#end([...ending.content, ...ending.empty], ids, windows),
    }
  }

  /**
   * The quit half: null when quitting ends no private chat with content in
   * any window; otherwise the one question, asked in `win`. Quitting needs no
   * discard afterwards: nothing of a private chat outlives the app.
   */
  quitEnding(): { ask(win: WindowContext): Promise<boolean> } | null {
    const ending = privateChatsEnding(this.#deps.openTabs(), [], this.#deps, 'all')
    if (ending.content.length === 0) return null
    return { ask: (win) => this.#deps.ask(win) }
  }

  /** Discards the chats that ended, unless one is on screen somewhere again by now. */
  #end(chatIds: readonly string[], closedTabIds: readonly string[], closingWindows: ClosingWindows = NO_WINDOWS): void {
    const staying = this.#deps.openTabs().filter((t) => !closedTabIds.includes(t.id))
    for (const id of chatIds) {
      if (this.#deps.privateState(id) === null || shownElsewhere(id, staying, this.#deps.viewing(), closingWindows)) continue
      try {
        this.#deps.discard(id)
      } catch {
        // Already gone.
      }
    }
  }
}

// ── The app's one guard (agent/feature installs it; app.ts's window guard asks it) ──

let current: PrivateCloseGuard | null = null

export function installPrivateClose(guard: PrivateCloseGuard | null): void {
  current = guard
}

/** For app.ts's window close guard: what closing this window would end, or null. */
export function privateWindowEnding(win: WindowContext): ReturnType<PrivateCloseGuard['windowEnding']> {
  return current?.windowEnding(win) ?? null
}

/** For app.ts's quit guard: what quitting would end, or null. */
export function privateQuitEnding(): ReturnType<PrivateCloseGuard['quitEnding']> {
  return current?.quitEnding() ?? null
}

export interface PrivateQuitDeps {
  ending(): ReturnType<PrivateCloseGuard['quitEnding']>
  /** The window to ask in (brought to the front first), or null when none is open. */
  window(): WindowContext | null
  /** True when the quit should go ahead untouched (smoke, an update installing). */
  skip(): boolean
  /** Quits again, once the person agreed. */
  quit(): void
}

/**
 * The 'before-quit' listener for every way Atelier quits (⌘Q, the app and Dock
 * menus, an OS logout): a private chat with content holds the quit and asks
 * once, covering every window; yes quits again, and that second pass goes
 * through. Installed ahead of the other before-quit listeners, which leave a
 * held quit alone (event.defaultPrevented).
 */
export function privateQuitGate(deps: PrivateQuitDeps): (event: { preventDefault(): void }) => void {
  let agreed = false
  let asking = false
  return (event) => {
    if (agreed) {
      agreed = false
      return
    }
    if (deps.skip()) return
    const ending = deps.ending()
    const win = ending ? deps.window() : null
    if (!ending || !win) return
    event.preventDefault()
    if (asking) return
    asking = true
    void ending
      .ask(win)
      // A question that can't show never keeps Atelier from quitting.
      .catch(() => true)
      .then((ok) => {
        if (!ok) return
        agreed = true
        deps.quit()
      })
      .finally(() => {
        asking = false
      })
  }
}
