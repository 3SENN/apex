/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_PROFILE_HUE, isProfileHue, profileVariables, type ProfileHue } from '@shared/profile'

// The profile hue goes on <html> as CSS variables (both modes, picked with
// light-dark() in styles.css), before the first render and live afterwards.
// It is the person's colour: the companion's accent never reaches the chrome.

let applied: ProfileHue | null = null

export function applyProfileHue(hue: unknown): void {
  const next = isProfileHue(hue) ? hue : DEFAULT_PROFILE_HUE
  if (next === applied || typeof document === 'undefined') return
  applied = next
  const root = document.documentElement
  root.dataset.profileHue = next
  for (const [name, value] of Object.entries(profileVariables(next))) root.style.setProperty(name, value)
}

if (typeof window !== 'undefined') applyProfileHue(window.apex?.initial?.settings?.profileHue)
