/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The permission prompt queue (OV-11). No Electron here, so it is
// unit-tested: identical simultaneous requests share one prompt, each tab
// shows one prompt at a time and the rest wait their turn, and a tab's
// prompts end (denied) when it closes or the agent takes control.

export interface PromptAnswer {
  allow: boolean
  remember: boolean
  /** The person put the prompt away (Esc) without deciding: counted toward the embargo, never stored. */
  dismissed?: boolean
}

/** What presenting a prompt returns: its answer (null when dismissed) and a way to close it early. */
export interface PromptHandle {
  result: Promise<PromptAnswer | null>
  close(): void
}

export interface QueuedPrompt<P> {
  /** Requests with the same key share one prompt (see promptKey). */
  key: string
  tabId: string
  props: P
}

type Settle = (answer: PromptAnswer | null) => void

interface Entry<P> {
  prompt: QueuedPrompt<P>
  waiters: Settle[]
  handle: PromptHandle | null
}

export class PromptQueue<P> {
  readonly #present: (prompt: QueuedPrompt<P>) => PromptHandle
  /** Per tab, in arrival order; the first one is on screen. */
  readonly #tabs = new Map<string, Entry<P>[]>()

  constructor(present: (prompt: QueuedPrompt<P>) => PromptHandle) {
    this.#present = present
  }

  /** Queues a prompt, or joins an identical one already waiting or open. Resolves with the answer, or null when it was dismissed or cancelled. */
  ask(prompt: QueuedPrompt<P>): Promise<PromptAnswer | null> {
    return new Promise((resolve) => {
      const list = this.#tabs.get(prompt.tabId) ?? []
      const same = list.find((e) => e.prompt.key === prompt.key)
      if (same) {
        same.waiters.push(resolve)
        return
      }
      list.push({ prompt, waiters: [resolve], handle: null })
      this.#tabs.set(prompt.tabId, list)
      if (list.length === 1) this.#show(prompt.tabId)
    })
  }

  /** Ends every prompt of a tab, open or waiting, as dismissed. */
  cancelTab(tabId: string): void {
    const list = this.#tabs.get(tabId)
    if (!list) return
    this.#tabs.delete(tabId)
    for (const entry of list) {
      entry.handle?.close()
      for (const settle of entry.waiters) settle(null)
    }
  }

  /** The prompts on screen and waiting, for diagnostics and smoke checks. */
  pending(): { key: string; tabId: string; open: boolean; waiters: number }[] {
    return [...this.#tabs.values()].flatMap((list) => list.map((e) => ({ key: e.prompt.key, tabId: e.prompt.tabId, open: e.handle !== null, waiters: e.waiters.length })))
  }

  #show(tabId: string): void {
    const entry = this.#tabs.get(tabId)?.[0]
    if (!entry || entry.handle) return
    let handle: PromptHandle
    try {
      handle = this.#present(entry.prompt)
    } catch {
      handle = { result: Promise.resolve(null), close: () => undefined }
    }
    entry.handle = handle
    void handle.result
      .catch(() => null)
      .then((answer) => {
        const list = this.#tabs.get(tabId)
        // Cancelled while open: cancelTab already settled it.
        if (!list || list[0] !== entry) return
        list.shift()
        if (list.length === 0) this.#tabs.delete(tabId)
        for (const settle of entry.waiters) settle(answer)
        this.#show(tabId)
      })
  }
}
