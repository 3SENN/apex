/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentHost } from '../agent/host'
import type { ChatStore } from '../chats'
import type { SettingsStore } from '../settings'
import type { SmokeClient } from '../smokeClient'
import type { Chrome } from '../smokeKit'
import type { SmokeServer } from '../smokeServer'
import type { TabManager } from '../tabs'

// The smoke harness's shapes. Each smoke group has a folder (src/main/smokeBrowser/,
// smokeVoicePasswords/, smokeFilesConnectors/, smokeAgentWorkspace/, smokeMaintenance/,
// smokeLayout/, smokeMedia/) or a feature's smoke.ts, with one file per area
// exporting `checks` and `shots`; smokeGroups.ts runs them in order, and
// APEX_SMOKE_ONLY=BROWSER,MAINTENANCE runs a subset.

export interface SmokeContext {
  chrome: Chrome
  tabs: TabManager
  host: AgentHost
  /** The offline Messages stand-in; chats never reach the network. */
  client: SmokeClient
  settings: SettingsStore
  chats: ChatStore
  server: SmokeServer
  /** Saves a screenshot of the window under APEX_SMOKE_SHOTS as <name>-<theme>.png; a no-op without it. */
  shot(name: string): Promise<void>
}

export interface SmokeCheck {
  name: string
  run(ctx: SmokeContext): Promise<void>
}

export interface ShotSpec {
  name: string
  run(ctx: SmokeContext): Promise<void>
}

export interface SmokeGroup {
  /** The name APEX_SMOKE_ONLY takes (any case) and the prefix of each check's name in the output. */
  group:
    | /* tabs, address bar, menus, settings, sites, the chat panel, sign-in (src/main/smokeBrowser) */ 'BROWSER'
    | /* speech, voice, meetings, passwords and autofill (src/main/smokeVoicePasswords) */ 'VOICE-PASSWORDS'
    | /* profiles, attachments, files, connectors, rich chat replies, extensions (src/main/smokeFilesConnectors) */ 'FILES-CONNECTORS'
    | /* the workspace, agent requests and approvals, memory, skills and routines, apps, chat tools, setup (src/main/smokeAgentWorkspace) */ 'AGENT-WORKSPACE'
    | /* diagnostics, migrations, updates, system, native, release and languages (src/main/smokeMaintenance) */ 'MAINTENANCE'
    | /* the layout audit (src/main/smokeLayout) */ 'LAYOUT' | /* tweaks (src/main/tweaks/smoke.ts) */ 'TWEAKS' | /* the media hub (src/main/smokeMedia) */ 'MEDIA' | /* the privacy pack (src/main/privacy/smoke.ts) */ 'PRIVACY' | /* page translation (src/main/translate/smoke.ts) */ 'TRANSLATE' | /* the reader (src/main/reader/smoke.ts) */ 'READER' | /* packs (src/main/packs/smoke.ts) */ 'PACKS' | /* quick decisions (src/main/decisions/smoke.ts) */ 'DECISIONS'
  checks: SmokeCheck[]
  shots: ShotSpec[]
}
