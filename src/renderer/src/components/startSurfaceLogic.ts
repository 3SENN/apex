/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-107: the start surface's pure decisions, unit-tested.

/**
 * Whether a chat view shows the start surface (DS-107): a draft (a new chat
 * before its first send) that has loaded, has nothing in its log, nothing on
 * its way and no migration notice, and is not an imported transcript.
 */
export function isStartSurface(chat: { empty: boolean; phase: string; draft: boolean | undefined; imported: unknown }): boolean {
  return chat.empty && chat.phase === 'ready' && chat.draft === true && !chat.imported
}

/**
 * DS-107: whether a chat view draws its header bar. The empty chat page is
 * the start surface, so it shows only the switcher pill, the floor and the
 * staged arrival: no bar. The switcher stays reachable in the start chrome,
 * so the bar only goes when that chrome shows (a companion to switch from).
 * The side panel keeps its header (its close and expand controls), and a
 * page that is still loading or failed draws none, as before.
 */
export function showsChatHeader(view: { variant: 'page' | 'panel'; phase: string; startSurface: boolean; hasCompanion: boolean }): boolean {
  if (view.variant === 'panel') return true
  if (view.phase !== 'ready') return false
  return !(view.startSurface && view.hasCompanion)
}
