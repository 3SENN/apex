/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@internal/engines/main` in a build from public code: no engines besides the
// API key. A build with the private internal/ folder takes
// internal/engines/main.ts, which has the same exports (src/main/engines/extras.ts).
import { noExtraEngines, type ExtraEngines, type ExtraEnginesDeps } from '../../main/engines/extras'
import type { ShotSpec } from '../../main/smokeBrowser/types'

/** The engines this build adds, with their backends, status and services. */
export function createExtraEngines(_deps: ExtraEnginesDeps): ExtraEngines {
  return noExtraEngines()
}

/** The argument schemas of the engines' service methods (src/main/services.ts). */
export const EXTRA_SERVICE_SCHEMAS = {}

/** The engines' screenshots in the end-to-end check's agent and workspace group (src/main/smokeAgentWorkspace). */
export const EXTRA_SMOKE_SHOTS: readonly ShotSpec[] = []
