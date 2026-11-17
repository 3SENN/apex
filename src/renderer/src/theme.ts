/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { accentVariables } from '@shared/accent'
import type { ThemeState } from '@shared/theme'

// Main resolves the theme (nativeTheme) and the accent; the chrome only
// applies them. main.tsx does that before the first render and keeps it live,
// so components read <html data-theme> or use useTheme().

let current: ThemeState = window.atelier.initial.theme

let switching = 0

/**
 * Sets data-theme, data-theme-pref and the accent variables on <html>. A
 * change of mode or colour repaints in one frame (DS-88): transitions are
 * held off for two frames so nothing crossfades; only the segmented thumb
 * glides (styles.css, [data-theme-switching]).
 */
export function applyTheme(theme: ThemeState): void {
  const changed = theme.mode !== current.mode || theme.accent !== current.accent
  current = theme
  const root = document.documentElement
  if (changed && root.dataset.theme) {
    const token = ++switching
    root.dataset.themeSwitching = ''
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (token === switching) delete root.dataset.themeSwitching
      }),
    )
  }
  root.dataset.theme = theme.mode
  root.dataset.themePref = theme.preference
  for (const [name, value] of Object.entries(accentVariables(theme.accent))) root.style.setProperty(name, value)
}

/** The current theme: preference, resolved mode and accent, kept live. */
export function useTheme(): ThemeState {
  const [theme, setTheme] = useState(current)
  useEffect(() => {
    setTheme(current)
    return window.atelier.onAppEvent((event) => {
      if (event.type === 'theme') setTheme(event.theme)
    })
  }, [])
  return theme
}
