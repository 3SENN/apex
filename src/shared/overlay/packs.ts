/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Packs' overlay surface: Apex's bar over an app whose web server runs
// (apex.server, docs/packs.md › A web server of its own).

export const PACKS_SURFACES = ['server-bar'] as const

export type PacksSurfaceId = (typeof PACKS_SURFACES)[number]

export interface ServerBarProps {
  tabId: string
  /** The app's name. */
  app: string
  /** Shared on the Wi-Fi, or on this computer only. */
  lan: boolean
  /** Open sockets. */
  connections: number
  /** The first time on the Wi-Fi on a Mac: macOS will ask about incoming connections. */
  hint: boolean
}

export type PacksSurfaceProps = {
  'server-bar': ServerBarProps
}
