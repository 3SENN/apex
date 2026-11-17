/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Tab } from './tabs'

// Popup policies. popups.ts asks every policy before it
// creates a window; the first non-null answer wins, and null means no opinion.

export interface PopupRequest {
  tab: Tab
  url: string
  disposition: string
  userGesture: boolean
  frameOrigin: string
}

export type PopupPolicy = (d: PopupRequest) => 'allow' | 'block' | null

const policies: PopupPolicy[] = []

export function registerPopupPolicy(fn: PopupPolicy): () => void {
  policies.push(fn)
  return () => {
    const i = policies.indexOf(fn)
    if (i >= 0) policies.splice(i, 1)
  }
}

export function consultPopupPolicies(d: PopupRequest): 'allow' | 'block' | null {
  for (const fn of policies) {
    const answer = fn(d)
    if (answer) return answer
  }
  return null
}
