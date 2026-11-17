/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, type WebContents } from 'electron'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'

// Which profile each window belongs to (SH-61: every window carries a
// profileId). Windows register when they're built; anything unregistered
// (the first window before profiles load, overlay renderers of an unknown
// window) is the default profile.

const byWindow = new Map<number, string>()

export function setWindowProfile(windowId: number, profileId: string): void {
  byWindow.set(windowId, profileId)
}

export function clearWindowProfile(windowId: number): void {
  byWindow.delete(windowId)
}

export function profileOfWindowId(windowId: number | null | undefined): string {
  return (windowId != null && byWindow.get(windowId)) || DEFAULT_PROFILE_ID
}

/** A chrome, overlay or tab webContents: the profile of the window that holds it. */
export function profileOfContents(contents: WebContents | null | undefined): string {
  if (!contents || contents.isDestroyed()) return DEFAULT_PROFILE_ID
  const win = BrowserWindow.fromWebContents(contents)
  return profileOfWindowId(win?.id)
}

export function windowIdsOfProfile(profileId: string, openIds: readonly number[]): number[] {
  return openIds.filter((id) => profileOfWindowId(id) === profileId)
}
