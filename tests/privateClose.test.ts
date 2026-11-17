/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PrivateCloseGuard, chatsOfTab, privateChatsEnding, privateCloseSpec, privateQuitGate, shownElsewhere, type OpenTab, type PrivateCloseDeps, type PrivateQuitDeps, type ViewingEntry } from '../src/main/agent/privateClose'
import type { WindowContext } from '../src/main/features/types'
import { ClosedTabStack, chatIdOf } from '../src/main/tabState'
import { WindowManager } from '../src/main/windows'

// CH-30: closing a tab or window that holds a private chat with content
// asks first; an empty one closes quietly. Fakes only: no Electron, no model.

const chatTab = (id: string, chatId: string, windowId = 1): OpenTab => ({ id, internalUrl: `atelier://chat/${chatId}`, windowId })
const webTab = (id: string, windowId = 1): OpenTab => ({ id, internalUrl: null, windowId })

function setup(opts: { tabs: OpenTab[]; states: Record<string, 'content' | 'empty'>; viewing?: ViewingEntry[]; answer?: boolean }) {
  let tabs = opts.tabs
  const discarded: string[] = []
  let resolveAsk: (ok: boolean) => void = () => undefined
  const ask = vi.fn(() => (opts.answer === undefined ? new Promise<boolean>((resolve) => (resolveAsk = resolve)) : Promise.resolve(opts.answer)))
  const deps: PrivateCloseDeps = {
    privateState: (id) => (discarded.includes(id) ? null : (opts.states[id] ?? null)),
    viewing: () => opts.viewing ?? [],
    openTabs: () => tabs,
    discard: (id) => void discarded.push(id),
    ask,
  }
  const guard = new PrivateCloseGuard(deps)
  const win = { id: 1 } as unknown as WindowContext
  const closeTab = (id: string): void => {
    tabs = tabs.filter((t) => t.id !== id)
  }
  return { guard, win, ask, discarded, closeTab, answer: (ok: boolean) => resolveAsk(ok), tabs: () => tabs }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('which private chats end', () => {
  it('finds a chat page and a chat held beside a website', () => {
    expect(chatsOfTab(chatTab('t1', 'c1'), [])).toEqual(['c1'])
    expect(chatsOfTab(webTab('t2'), [['page:t2', 'c2']])).toEqual(['c2'])
    expect(chatsOfTab(webTab('t3'), [['page:t2', 'c2']])).toEqual([])
  })

  it('splits private chats by content and leaves other chats alone', () => {
    const states = { secret: 'content', blank: 'empty' } as const
    const deps = { privateState: (id: string) => states[id as keyof typeof states] ?? null, viewing: () => [] }
    expect(privateChatsEnding([chatTab('t1', 'secret'), chatTab('t2', 'blank'), chatTab('t3', 'normal'), webTab('t4')], [], deps)).toEqual({ content: ['secret'], empty: ['blank'] })
  })

  it('a chat still shown in another tab or the side panel is not ending', () => {
    expect(shownElsewhere('c1', [chatTab('t2', 'c1')], [])).toBe(true)
    expect(shownElsewhere('c1', [], [['panel', 'c1']])).toBe(true)
    // The closing tab's own page surface doesn't count, nor does another chat in the panel.
    expect(shownElsewhere('c1', [webTab('t2')], [['page:t1', 'c1'], ['panel', 'c9']])).toBe(false)
  })

  it('uses the question ending a private chat asks, as a destructive confirm', () => {
    const spec = privateCloseSpec()
    expect(spec.title).toBe('Discard this private chat?')
    expect(spec.description).toBe('Nothing of it was saved, so it can’t be brought back.')
    expect(spec.buttons.map((b) => [b.id, b.label, b.style])).toEqual([
      ['cancel', 'Cancel', 'secondary'],
      ['confirm', 'Discard', 'destructive'],
    ])
    expect(spec.dedupeKey).toBe(`chrome:${spec.title}:${spec.description}`)
  })
})

describe('closing a tab', () => {
  it('asks for a private chat with content, then closes and discards on yes', async () => {
    const s = setup({ tabs: [chatTab('t1', 'secret'), webTab('t2')], states: { secret: 'content' } })
    const proceed = vi.fn(() => s.closeTab('t1'))
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, proceed)).toBe(true)
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(proceed).not.toHaveBeenCalled()
    // A second press (⌘W again, middle-click) while it asks waits for the same answer.
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, proceed)).toBe(true)
    expect(s.ask).toHaveBeenCalledTimes(1)
    s.answer(true)
    await flush()
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(s.discarded).toEqual(['secret'])
  })

  it('keeps the tab and the chat on cancel', async () => {
    const s = setup({ tabs: [chatTab('t1', 'secret')], states: { secret: 'content' }, answer: false })
    const proceed = vi.fn()
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, proceed)).toBe(true)
    await flush()
    expect(proceed).not.toHaveBeenCalled()
    expect(s.discarded).toEqual([])
    // It asks again next time.
    s.guard.tabClosing(s.win, s.tabs()[0]!, proceed)
    expect(s.ask).toHaveBeenCalledTimes(2)
  })

  it('closes an empty private chat without asking, and discards it', async () => {
    const s = setup({ tabs: [chatTab('t1', 'blank')], states: { blank: 'empty' } })
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, vi.fn())).toBe(false)
    s.closeTab('t1')
    await flush()
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.discarded).toEqual(['blank'])
  })

  it('does not ask for a normal chat, a website, or a private chat open in another tab', () => {
    const s = setup({ tabs: [chatTab('t1', 'normal'), webTab('t2'), chatTab('t3', 'secret'), chatTab('t4', 'secret')], states: { secret: 'content' } })
    for (const tab of s.tabs().slice(0, 3)) expect(s.guard.tabClosing(s.win, tab, vi.fn())).toBe(false)
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('asks for a website tab that holds a private chat beside its page', () => {
    const s = setup({ tabs: [webTab('t1')], states: { secret: 'content' }, viewing: [['page:t1', 'secret']] })
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, vi.fn())).toBe(true)
    expect(s.ask).toHaveBeenCalledTimes(1)
  })

  it('a chat moved to the panel before its tab closes is not ending', () => {
    const s = setup({ tabs: [chatTab('t1', 'secret')], states: { secret: 'content' }, viewing: [['panel', 'secret']] })
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, vi.fn())).toBe(false)
    expect(s.ask).not.toHaveBeenCalled()
  })
})

describe('closing a window', () => {
  it('has nothing to ask without a private chat with content in its tabs', () => {
    const s = setup({ tabs: [chatTab('t1', 'blank'), webTab('t2'), chatTab('t3', 'secret', 2)], states: { blank: 'empty', secret: 'content' } })
    expect(s.guard.windowEnding(s.win)).toBeNull()
  })

  it('asks, then discards its private chats once it has closed', async () => {
    const s = setup({ tabs: [chatTab('t1', 'secret'), chatTab('t2', 'blank'), chatTab('t3', 'other', 2)], states: { secret: 'content', blank: 'empty', other: 'content' }, answer: true })
    const ending = s.guard.windowEnding(s.win)
    expect(ending).not.toBeNull()
    expect(await ending!.ask()).toBe(true)
    ending!.end()
    expect(s.discarded).toEqual(['secret', 'blank'])
  })

  it('leaves a private chat that another window still shows', () => {
    const s = setup({ tabs: [chatTab('t1', 'secret'), chatTab('t2', 'secret', 2)], states: { secret: 'content' } })
    expect(s.guard.windowEnding(s.win)).toBeNull()
  })
})

describe('closing a window whose side panel shows a private chat', () => {
  it('asks for the chat in its own panel, then discards it once the window has closed', async () => {
    const s = setup({ tabs: [webTab('t1'), webTab('t2', 2)], states: { secret: 'content' }, viewing: [['panel', 'secret', 1]], answer: true })
    const ending = s.guard.windowEnding(s.win)
    expect(ending).not.toBeNull()
    expect(await ending!.ask()).toBe(true)
    ending!.end()
    expect(s.discarded).toEqual(['secret'])
  })

  it('leaves a chat that another window’s panel still shows, and a chat only another window’s panel shows', () => {
    expect(setup({ tabs: [webTab('t1')], states: { secret: 'content' }, viewing: [['panel', 'secret', 1], ['panel', 'secret', 2]] }).guard.windowEnding({ id: 1 } as WindowContext)).toBeNull()
    expect(setup({ tabs: [webTab('t1')], states: { secret: 'content' }, viewing: [['panel', 'secret', 2]] }).guard.windowEnding({ id: 1 } as WindowContext)).toBeNull()
  })

  it('covers a details view too, and an empty private chat in the panel closes quietly', () => {
    expect(setup({ tabs: [webTab('t1')], states: { secret: 'content' }, viewing: [['details:secret', 'secret', 1]] }).guard.windowEnding({ id: 1 } as WindowContext)).not.toBeNull()
    expect(setup({ tabs: [webTab('t1')], states: { blank: 'empty' }, viewing: [['panel', 'blank', 1]] }).guard.windowEnding({ id: 1 } as WindowContext)).toBeNull()
  })

  it('closing a tab still doesn’t ask while its own window’s panel shows the chat', () => {
    const s = setup({ tabs: [chatTab('t1', 'secret')], states: { secret: 'content' }, viewing: [['panel', 'secret', 1]] })
    expect(s.guard.tabClosing(s.win, s.tabs()[0]!, vi.fn())).toBe(false)
    expect(s.ask).not.toHaveBeenCalled()
  })
})

describe('quitting (⌘Q, the Dock, the menus)', () => {
  it('ends every private chat with content in any window, in a tab or a side panel', () => {
    expect(setup({ tabs: [chatTab('t1', 'secret', 2)], states: { secret: 'content' } }).guard.quitEnding()).not.toBeNull()
    expect(setup({ tabs: [webTab('t1')], states: { secret: 'content' }, viewing: [['panel', 'secret', 3]] }).guard.quitEnding()).not.toBeNull()
    expect(setup({ tabs: [chatTab('t1', 'blank'), chatTab('t2', 'normal')], states: { blank: 'empty' } }).guard.quitEnding()).toBeNull()
  })

  function gate(over: Partial<PrivateQuitDeps> & { answer?: Promise<boolean> } = {}) {
    const ask = vi.fn(() => over.answer ?? Promise.resolve(true))
    const quit = vi.fn()
    const win = { id: 1 } as WindowContext
    const listener = privateQuitGate({ ending: () => ({ ask }), window: () => win, skip: () => false, quit, ...over })
    const quitting = (): boolean => {
      let held = false
      listener({ preventDefault: () => void (held = true) })
      return !held
    }
    return { ask, quit, quitting, win }
  }

  it('holds the quit and asks once, covering every window; yes quits, and that quit goes through', async () => {
    let answer: (ok: boolean) => void = () => undefined
    const g = gate({ answer: new Promise<boolean>((resolve) => (answer = resolve)) })
    expect(g.quitting()).toBe(false)
    // ⌘Q again while it asks waits for the same answer.
    expect(g.quitting()).toBe(false)
    expect(g.ask).toHaveBeenCalledTimes(1)
    expect(g.ask).toHaveBeenCalledWith(g.win)
    answer(true)
    await flush()
    expect(g.quit).toHaveBeenCalledTimes(1)
    expect(g.quitting()).toBe(true)
    expect(g.ask).toHaveBeenCalledTimes(1)
  })

  it('stays open on cancel, and asks again next time', async () => {
    const g = gate({ answer: Promise.resolve(false) })
    expect(g.quitting()).toBe(false)
    await flush()
    expect(g.quit).not.toHaveBeenCalled()
    expect(g.quitting()).toBe(false)
    expect(g.ask).toHaveBeenCalledTimes(2)
  })

  it('quits untouched with nothing to lose, no window, or an update installing; a question that fails never traps the app', async () => {
    expect(gate({ ending: () => null }).quitting()).toBe(true)
    expect(gate({ window: () => null }).quitting()).toBe(true)
    expect(gate({ skip: () => true }).quitting()).toBe(true)
    const broken = gate({ answer: Promise.reject(new Error('no overlay')) })
    expect(broken.quitting()).toBe(false)
    await flush()
    expect(broken.quit).toHaveBeenCalledTimes(1)
  })
})

// ⇧⌘T and History › Recently closed: a private chat's tab never goes on the reopen stacks.
function fakeWindow(id: number, kind: WindowContext['kind'], urls: string[]) {
  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    getTitle: () => `Window ${id}`,
    getNormalBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  })
  const tabs = urls.map((url, i) => ({ id: `${id}-${i}`, pinned: false, internalUrl: url.startsWith('atelier://') ? url : null, view: { webContents: { isDestroyed: () => true } } }))
  const info = (t: (typeof tabs)[number]) => ({ id: t.id, url: urls[Number(t.id.split('-')[1])] ?? '', title: 'T', pinned: false, groupId: null })
  const tabsEmitter = Object.assign(new EventEmitter(), {
    all: () => tabs,
    info,
    activeId: () => tabs[0]?.id ?? null,
    split: () => null,
    snapshot: () => ({ groups: [] }),
    serialize: () => tabs.map((t) => ({ url: info(t).url, title: 'T', pinned: false, groupId: null, entries: [{ url: info(t).url, title: 'T' }], index: 0 })),
  })
  const win = {
    id,
    kind,
    window,
    chrome: { isDestroyed: () => false, send: () => undefined },
    tabs: tabsEmitter,
    overlay: { ownsWebContents: () => false, relay: () => undefined },
    chromeWindow: { state: () => ({ sidebarOpen: true, name: null }) },
  } as unknown as WindowContext
  return { win, tabs, tabsEmitter, window }
}

describe('reopening closed tabs (⇧⌘T) leaves out private chats', () => {
  const privateIds = new Set(['secret'])
  const ephemeral = (url: string): boolean => {
    const id = chatIdOf(url)
    return id !== null && privateIds.has(id)
  }

  it('skips a closed private chat tab, keeps other chats and websites', () => {
    const wm = new WindowManager()
    wm.setEphemeral(ephemeral)
    const a = fakeWindow(1, 'normal', ['https://a.test/', 'atelier://chat/secret', 'atelier://chat/normal'])
    wm.add(a.win)
    for (const tab of a.tabs) a.tabsEmitter.emit('closed', tab)
    expect(wm.recentlyClosed().map((e) => (e.kind === 'chat' ? e.chatId : e.kind === 'tab' ? e.url : e.kind))).toEqual(['normal', 'https://a.test/'])
  })

  it('a closed window comes back without its private chat tab, and so does the saved session', () => {
    const wm = new WindowManager()
    wm.setEphemeral(ephemeral)
    const a = fakeWindow(1, 'normal', ['atelier://chat/secret', 'https://a.test/'])
    wm.add(a.win)
    wm.add(fakeWindow(2, 'normal', ['https://b.test/']).win)
    expect(wm.serializeWindow(a.win)?.tabs.map((t) => t.url)).toEqual(['https://a.test/'])
    a.window.emit('close', { preventDefault: () => undefined })
    expect(wm.recentlyClosed()).toMatchObject([{ kind: 'window', tabCount: 1 }])
  })

  it('a popped-out private chat window is not remembered', () => {
    const wm = new WindowManager()
    wm.setEphemeral(ephemeral)
    const chat = fakeWindow(3, 'chat', ['atelier://chat/secret'])
    wm.add(chat.win)
    wm.add(fakeWindow(1, 'normal', ['https://a.test/']).win)
    chat.window.emit('close', { preventDefault: () => undefined })
    expect(wm.recentlyClosed()).toEqual([])
  })

  it('the tab strip’s own reopen stack skips them too', () => {
    const stack = new ClosedTabStack()
    stack.setSkip(ephemeral)
    stack.push({ url: 'atelier://chat/secret', title: 'Private', pinned: false, index: 0 })
    stack.push({ url: 'https://a.test/', title: 'A', pinned: false, index: 1 })
    expect(stack.size).toBe(1)
    expect(stack.pop()?.url).toBe('https://a.test/')
  })
})
