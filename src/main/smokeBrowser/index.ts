/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as address from './address'
import * as addressInput from './addressInput'
import * as chat from './chat'
import * as chatTabs from './chatTabs'
import * as clear from './clear' // Clear in the sidebar's Your tabs and Chats headers, with Undo
import * as sidebarReveal from './sidebarReveal' // SH-04: the hidden sidebar floats out at the left edge
import * as closeX from './closeX' // a real press on the rows' close X
import * as core from './core'
import * as identity from './identity' // sign-in compatibility: what sites see of Atelier
import * as menus from './menus'
import * as newTabSearch from './newTabSearch' // NT-01
import * as settings from './settings'
import * as signInCompat from './signInCompat' // sign-in compatibility: popups, redirects, FedCM, WebAuthn, third-party cookies
import * as sites from './sites'
import * as tabs from './tabs'
import * as tabDrag from './tabDrag' // SH-30, DS-16: a real drag in the sidebar
import type { SmokeGroup, ShotSpec, SmokeCheck } from './types'

export type { SmokeGroup, ShotSpec, SmokeCheck, SmokeContext } from './types'

// The browser smoke group's checks (ATELIER_SMOKE_ONLY=BROWSER), in their run order.
const PARTS = [core, settings, menus, address, addressInput, newTabSearch, tabs, tabDrag, sites, chat, chatTabs, identity, signInCompat, closeX, clear, sidebarReveal]

export const checks: SmokeCheck[] = PARTS.flatMap((l) => l.checks)
export const shots: ShotSpec[] = PARTS.flatMap((l) => l.shots)

export const browserSmoke: SmokeGroup = { group: 'BROWSER', checks, shots }
