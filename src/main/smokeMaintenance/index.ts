/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SmokeGroup, ShotSpec, SmokeCheck } from '../smokeBrowser/types'
import * as diagnostics from './diagnostics'
import * as i18n from './i18n'
import * as migrations from './migrations'
import * as native from './native'
import * as release from './release'
import * as system from './system'
import * as updates from './updates'

// The maintenance smoke group's checks and screenshot specs: diagnostics,
// migrations, updates, system, native, release and languages
// (ATELIER_SMOKE_ONLY=MAINTENANCE runs only these).
// Smoke never makes a request outside the local fixture server, never calls
// setLoginItemSettings and never quits for an update.

// Run order: the diagnostics logger first.
const PARTS = [diagnostics, migrations, updates, system, native, release, i18n]

export const checks: SmokeCheck[] = PARTS.flatMap((l) => l.checks)
export const shots: ShotSpec[] = PARTS.flatMap((l) => l.shots)

export const maintenanceSmoke: SmokeGroup = { group: 'MAINTENANCE', checks, shots }
