/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { log } from './log'

// Sleeping tabs (SS-07). After `tabSleepMinutes` in the background a tab's
// page is discarded; selecting it again restores it with its history
// (TabManager.sleep and wake). Some tabs never sleep: you would lose
// something or notice it stopping.

/** What the rule needs to know about one tab. */
export interface SleepCandidate {
  /** Shown right now: the active tab or either split pane. */
  visible: boolean
  pinned: boolean
  audible: boolean
  capturing: boolean
  agentControlled: boolean
  /** Already asleep, or restored lazily and never shown. */
  asleep: boolean
  /** atelier:// pages and the new tab are drawn by the chrome and cost nothing. */
  chromeDrawn: boolean
  lastActiveAt: number
}

/** Whether a tab may be put to sleep now. `minutes` null turns sleeping off. */
export function canSleep(tab: SleepCandidate, now: number, minutes: number | null): boolean {
  if (minutes === null || minutes <= 0) return false
  if (tab.visible || tab.pinned || tab.audible || tab.capturing || tab.agentControlled || tab.asleep || tab.chromeDrawn) return false
  return now - tab.lastActiveAt >= minutes * 60_000
}

/**
 * Runs in the page's isolated world (it shares the DOM, not the page's
 * script): true when a field was edited, so the tab must not sleep.
 */
export const EDITED_FORMS_SCRIPT = `(() => {
  const fields = document.querySelectorAll('input, textarea, select')
  for (const el of fields) {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked !== el.defaultChecked) return true; continue }
      if (el.value !== el.defaultValue) return true
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value !== el.defaultValue) return true
    } else if (el instanceof HTMLSelectElement) {
      for (const o of el.options) if (o.selected !== o.defaultSelected) return true
    }
  }
  const active = document.activeElement
  return Boolean(active && active.isContentEditable)
})()`

export interface SleeperDeps {
  /** Minutes before a background tab sleeps; null for never. */
  minutes(): number | null
  /** Every tab id that may sleep by the pure rule. */
  candidates(now: number): string[]
  /** True when the page has edited form fields (checked last, it asks the page). */
  hasEditedForms(id: string): Promise<boolean>
  sleep(id: string): void
}

/** Checks once a minute and puts eligible tabs to sleep. */
export class TabSleeper {
  readonly #deps: SleeperDeps
  #timer: ReturnType<typeof setInterval> | null = null
  #busy = false

  constructor(deps: SleeperDeps, intervalMs = 60_000) {
    this.#deps = deps
    this.#timer = setInterval(() => void this.check(), intervalMs)
    this.#timer.unref?.()
  }

  async check(now = Date.now()): Promise<number> {
    if (this.#busy || this.#deps.minutes() === null) return 0
    this.#busy = true
    let slept = 0
    try {
      for (const id of this.#deps.candidates(now)) {
        const edited = await this.#deps.hasEditedForms(id).catch(() => true)
        if (edited) continue
        try {
          this.#deps.sleep(id)
          slept++
        } catch (err) {
          log.warn('tabs', 'A tab could not sleep', { error: err instanceof Error ? err.message : String(err) })
        }
      }
    } finally {
      this.#busy = false
    }
    return slept
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}
