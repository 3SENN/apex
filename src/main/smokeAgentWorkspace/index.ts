/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EXTRA_SMOKE_SHOTS } from '@engines/main'
import type { SmokeGroup, ShotSpec, SmokeCheck } from '../smokeBrowser/types'
import * as agent from './agent'
import * as chat from './chat'
import * as memory from './memory'
import * as onboarding from './onboarding'
import * as platform from './platform'
import * as skills from './skills'
import * as workspace from './workspace'

// The agent and workspace smoke group's checks and screenshot specs: the
// workspace, the agent tools, memory, skills and routines, apps, chat tools and
// setup (ATELIER_SMOKE_ONLY=AGENT-WORKSPACE runs only these). No
// request leaves the machine: scripted model turns go through the offline
// client's registerScenario, the calendar uses a fake helper, and atelier-app
// partitions are checked to make no network request.

// Run order: workspace (db, versions, trash) and the agent core first,
// then memory, skills and routines, platform, chat, first run.
const PARTS = [workspace, agent, memory, skills, platform, chat, onboarding]

export const checks: SmokeCheck[] = PARTS.flatMap((l) => l.checks)
// The engines a build adds bring their own screenshots (src/main/engines/extras.ts).
export const shots: ShotSpec[] = [...PARTS.flatMap((l) => l.shots), ...EXTRA_SMOKE_SHOTS]

export const agentWorkspaceSmoke: SmokeGroup = { group: 'AGENT-WORKSPACE', checks, shots }
