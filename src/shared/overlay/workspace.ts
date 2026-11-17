/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace overlay surfaces: the space switcher from
// the Space row and the folder access prompt (CH-43), which
// mounts FolderAccessDialog. On a space switch, interactive surfaces
// anchored to a tab of the old space close; window-anchored ones stay.
export const WORKSPACE_SURFACES = ['space-switcher', 'folder-access'] as const

export type WorkspaceSurfaceId = (typeof WORKSPACE_SURFACES)[number]

export interface WorkspaceSurfaceProps {
  /** Lists the host's own window; the chrome doesn't know its window id, so this is only a hint. */
  'space-switcher': { windowId?: number }
  /** Resolves with the granted WatchedFolder, or null. */
  'folder-access': { path: string; chatId: string | null }
}
