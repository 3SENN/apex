/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { claudeCodeExtras } from '../../src/engines/main'
import { ClaudeCodeEngine, type ClaudeCodeEngineDeps } from '../../src/engines/claude-code/main/engine'
import type { ClaudeCodeStatus } from '../../src/engines/claude-code/shared/status'
import type { EngineStatus } from '@shared/engine'
import { EngineService, type EngineServiceDeps } from '../../src/main/engines/service'

// The app's EngineService with the Claude subscription engine made from the test's
// own fakes (the shell, what is runnable, the spawn), plus the engine's own
// methods where the tests used to find them on the service.

export type TestEngineDeps = Omit<EngineServiceDeps, 'appRoot' | 'smoke' | 'pickFile' | 'retry' | 'updateSettings' | 'extras'> &
  Partial<Pick<EngineServiceDeps, 'appRoot' | 'smoke' | 'pickFile' | 'retry' | 'updateSettings'>> &
  Pick<ClaudeCodeEngineDeps, 'available' | 'isExecutable' | 'spawn'>

export interface TestEngines extends EngineService {
  claude: ClaudeCodeEngine
  backend: ClaudeCodeEngine['backend']
  /** Finds the CLI again; the whole status, as the engine service used to answer. */
  recheck(): Promise<EngineStatus>
  openSignIn(): Promise<void>
  updateCli: ClaudeCodeEngine['updateCli']
  cli: ClaudeCodeEngine['cli']
}

export function claudeCodeEngines(deps: TestEngineDeps): TestEngines {
  let claude: ClaudeCodeEngine | null = null
  const engines = new EngineService({
    appRoot: process.cwd(),
    smoke: false,
    pickFile: async () => null,
    retry: () => undefined,
    updateSettings: () => undefined,
    ...deps,
    extras: (d) => {
      claude = new ClaudeCodeEngine({ ...d, ...(deps.run ? { run: deps.run } : {}), ...(deps.shell ? { shell: deps.shell } : {}), ...(deps.isExecutable ? { isExecutable: deps.isExecutable } : {}), ...(deps.spawn ? { spawn: deps.spawn } : {}), available: deps.available ?? true })
      return claudeCodeExtras(claude, d)
    },
  })
  const engine = claude as ClaudeCodeEngine | null
  if (!engine) throw new Error('The engine service made no Claude subscription engine.')
  return Object.assign(engines, {
    claude: engine,
    backend: engine.backend,
    recheck: async (): Promise<EngineStatus> => {
      await engine.recheck()
      return engines.status()
    },
    openSignIn: () => engine.openSignIn(),
    updateCli: (model?: string | null) => engine.updateCli(model ?? null),
    cli: () => engine.cli(),
  }) as TestEngines
}

export type { ClaudeCodeStatus }
