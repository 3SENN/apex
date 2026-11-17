/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { nativeTheme } from 'electron'
import { resolveAccent, type AccentChoice, type ThemePreference, type ThemeState } from '@shared/theme'

interface ThemeSource {
  preference(): ThemePreference
  accentChoice(): AccentChoice
  /** The active companion's accent colour. */
  companionAccent(): string
}

/** Emits 'changed' when the accents packs add change (docs/packs.md), so a chosen pack accent shows at once. */
export const packAccentEvents = new EventEmitter<{ changed: [] }>()

/**
 * Owns nativeTheme.themeSource. Setting it flips prefers-color-scheme in the
 * chrome, popups, the peek view and websites at once; this class turns the
 * result into one ThemeState and emits 'changed' whenever any part of it moves.
 */
export class ThemeController extends EventEmitter<{ changed: [ThemeState] }> {
  readonly #source: ThemeSource
  #last = ''

  constructor(source: ThemeSource) {
    super()
    this.#source = source
    nativeTheme.themeSource = source.preference()
    this.#last = JSON.stringify(this.state())
    nativeTheme.on('updated', () => this.#publish())
    packAccentEvents.on('changed', () => this.#publish())
  }

  state(): ThemeState {
    const accentChoice = this.#source.accentChoice()
    return {
      preference: this.#source.preference(),
      mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      accentChoice,
      accent: resolveAccent(accentChoice, this.#source.companionAccent()),
    }
  }

  /** Call after the theme setting, the accent setting or the companion changed. */
  refresh(): void {
    const preference = this.#source.preference()
    // nativeTheme emits 'updated' when the source changes the resolved mode.
    if (nativeTheme.themeSource !== preference) nativeTheme.themeSource = preference
    this.#publish()
  }

  #publish(): void {
    const state = this.state()
    const key = JSON.stringify(state)
    if (key === this.#last) return
    this.#last = key
    this.emit('changed', state)
  }
}
