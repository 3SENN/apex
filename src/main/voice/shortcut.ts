/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The launcher's global shortcut. It is an ordinary registered
// shortcut, never input monitoring, and it exists only while the launcher
// switch is on and no Atelier window has focus: inside Atelier the same keys are
// hold-to-talk. A failed registration (another app holds the keys) is a
// conflict that Settings › Voice shows. Never registered under ATELIER_SMOKE.
// Electron's globalShortcut is injected, so this is tested without it.

export interface ShortcutBackend {
  register(accelerator: string, fn: () => void): boolean
  unregister(accelerator: string): void
}

export interface ShortcutDeps {
  backend: ShortcutBackend
  /** settings.voice.launcher, and the accelerator for the chord. */
  wanted(): { on: boolean; accelerator: string }
  /** Any Atelier window (browser or float) has focus. */
  atelierFocused(): boolean
  onPress(): void
  /** Under ATELIER_SMOKE nothing is ever registered. */
  smoke: boolean
  onChange?(status: { registered: boolean; conflict: boolean }): void
}

export class LauncherShortcut {
  readonly #deps: ShortcutDeps
  /** The accelerator currently registered, if any. */
  #held: string | null = null
  /** The last attempt for this accelerator failed. */
  #conflict: { accelerator: string } | null = null
  #lastOk: string | null = null

  constructor(deps: ShortcutDeps) {
    this.#deps = deps
  }

  /** Registers or unregisters to match the switch, the chord and focus. */
  reconcile(): void {
    const { on, accelerator } = this.#deps.wanted()
    const want = on && !this.#deps.smoke && !this.#deps.atelierFocused()
    const before = this.status()
    if (this.#held && (!want || this.#held !== accelerator)) {
      this.#deps.backend.unregister(this.#held)
      this.#held = null
    }
    if (want && !this.#held) {
      let ok = false
      try {
        ok = this.#deps.backend.register(accelerator, () => this.#deps.onPress())
      } catch {
        ok = false
      }
      if (ok) {
        this.#held = accelerator
        this.#lastOk = accelerator
        this.#conflict = null
      } else {
        this.#conflict = { accelerator }
      }
    }
    if (!on) this.#conflict = null
    const after = this.status()
    if (after.registered !== before.registered || after.conflict !== before.conflict) this.#deps.onChange?.(after)
  }

  /**
   * Settings › Voice reads this while Atelier has focus, so `registered` means
   * "works once you leave Atelier": the last attempt for this chord succeeded,
   * or nothing has failed yet.
   */
  status(): { registered: boolean; conflict: boolean } {
    const { on, accelerator } = this.#deps.wanted()
    if (!on || this.#deps.smoke) return { registered: false, conflict: false }
    const conflict = this.#conflict?.accelerator === accelerator
    return { registered: this.#held === accelerator || (!conflict && this.#lastOk === accelerator), conflict }
  }

  /** Tries the keys once now (Settings turned the switch on while Atelier is focused), then lets focus decide. */
  probe(): void {
    const { on, accelerator } = this.#deps.wanted()
    if (!on || this.#deps.smoke || this.#held) return
    let ok = false
    try {
      ok = this.#deps.backend.register(accelerator, () => this.#deps.onPress())
    } catch {
      ok = false
    }
    if (ok) {
      this.#lastOk = accelerator
      this.#conflict = null
      this.#deps.backend.unregister(accelerator)
    } else {
      this.#conflict = { accelerator }
    }
    this.#deps.onChange?.(this.status())
    this.reconcile()
  }

  dispose(): void {
    if (this.#held) this.#deps.backend.unregister(this.#held)
    this.#held = null
  }
}
