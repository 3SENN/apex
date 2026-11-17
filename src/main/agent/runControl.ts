/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Run control for one chat (CH-14, CH-16, CH-17; pause and resume):
// why a run stopped, a gate that holds the run at its next safe point while
// paused, and notes that ride along with the next tool result.

export type StopReason = 'user' | 'interrupt'

/** Interrupt's reason on the abort signal, so a catch can tell it from a stop. */
export class InterruptSignal extends Error {
  constructor() {
    super('Interrupted by a new message.')
    this.name = 'InterruptSignal'
  }
}

/** Results for steps a stop or an interrupt skipped; every started call still gets one, so the history stays valid. */
export const INTERRUPTED = 'Not executed: the user interrupted with a new message. Read it and continue from there.'

/**
 * Holds a run at its next safe point (before a tool call or a model step)
 * while paused. Resume, stop and interrupt all let it through.
 */
export class RunGate {
  #paused = false
  #waiters: Array<() => void> = []

  get paused(): boolean {
    return this.#paused
  }

  pause(): void {
    this.#paused = true
  }

  resume(): void {
    this.#paused = false
    for (const open of this.#waiters.splice(0)) open()
  }

  /** Resolves at once unless paused; rejects with the signal's reason when it aborts while waiting. */
  wait(signal?: AbortSignal): Promise<void> {
    if (!this.#paused) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        this.#waiters = this.#waiters.filter((w) => w !== done)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Stopped.'))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#waiters.push(done)
    })
  }
}

/** Notes for the agent's next tool result on a tab (denied permission requests, OV-12). */
export class TabNotes {
  readonly #notes = new Map<string, string[]>()

  add(tabId: string, text: string): void {
    const clean = text.trim().slice(0, 2000)
    if (!clean) return
    const list = this.#notes.get(tabId) ?? []
    // A page that keeps asking doesn't flood the result.
    if (list.length < 5 && !list.includes(clean)) list.push(clean)
    this.#notes.set(tabId, list)
  }

  /** Takes every note for these tabs. */
  take(tabIds: readonly string[]): string[] {
    const out: string[] = []
    for (const tabId of tabIds) {
      out.push(...(this.#notes.get(tabId) ?? []))
      this.#notes.delete(tabId)
    }
    return out
  }

  drop(tabId: string): void {
    this.#notes.delete(tabId)
  }
}

/** How notes read in a tool result: Atelier's own words, marked so the model knows they aren't the page's. */
export function noteBlock(notes: readonly string[]): { type: 'text'; text: string } | null {
  if (notes.length === 0) return null
  return { type: 'text', text: `<atelier_note>\n${notes.join('\n')}\n</atelier_note>` }
}
