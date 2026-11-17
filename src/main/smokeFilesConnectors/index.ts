/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SmokeGroup, ShotSpec, SmokeCheck } from '../smokeBrowser/types'
import * as agent from './agent'
import * as applePasswords from './applePasswords'
import * as composer from './composer'
import * as connectors from './connectors'
import * as extensions from './extensions'
import * as files from './files'
import * as intake from './intake'
import * as profiles from './profiles'

// The files and connectors smoke group's checks and screenshot specs: profiles,
// attachments, files, connectors, the rich chat turn, the composer and
// extensions (APEX_SMOKE_ONLY=FILES-CONNECTORS runs only these).
// Nothing leaves the machine: the Messages and Files APIs, compaction and
// code execution are stubbed by the offline client, MCP and OAuth servers
// are local fixtures, and favicons stay off.

// The features' merge order: profiles' sessions first, then intake and
// files, connectors, the agent turn, the composer and extensions.
const PARTS = [profiles, intake, files, connectors, agent, composer, extensions, applePasswords]

export const checks: SmokeCheck[] = PARTS.flatMap((l) => l.checks)
export const shots: ShotSpec[] = PARTS.flatMap((l) => l.shots)

export const filesConnectorsSmoke: SmokeGroup = { group: 'FILES-CONNECTORS', checks, shots }
