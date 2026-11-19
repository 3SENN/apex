/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@engines/main`: the Claude subscription engine for the main process
// (ST-58, ST-59), behind src/main/engines/extras.ts.
import { BRAND_NAME } from '@shared/branding'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { EngineStatus } from '@shared/engine'
import type { ExtraEngines, ExtraEnginesDeps } from '../../src/main/engines/extras'
import { mainT } from '../../src/main/i18n/mainT'
import type { ShotSpec } from '../../src/main/smokeBrowser/types'
import { childEnv, isExecutableFile } from './claude-code/main/cli'
import { configureDocumentsWorkspace } from './claude-code/main/documentsWorkspace'
import { CLAUDE_CODE_ENGINE_BUILT, ClaudeCodeEngine, type ClaudeCodeEngineDeps } from './claude-code/main/engine'
import { claudeQuickEngine, spawnClaudeOnce } from './claude-code/main/quick'
import { claudeCodeReady } from './claude-code/shared/status'

/** The offline stand-in CLI for the end-to-end check (ATELIER_SMOKE_FAKE_CLAUDE=1 from a checkout). */
export const FAKE_CLAUDE = join('tests', 'fixtures', 'fake-claude.mjs')

export function createExtraEngines(deps: ExtraEnginesDeps): ExtraEngines {
  configureDocumentsWorkspace(deps.dataDir) // Claude Code's per-chat documents folders
  return claudeCodeExtras(new ClaudeCodeEngine({ ...deps, available: CLAUDE_CODE_ENGINE_BUILT, ...(deps.smoke ? smokeEngine(deps.appRoot) : {}) }), deps)
}

/** The engine as the app's extra engines (tests pass an engine made with their own fakes). */
export function claudeCodeExtras(engine: ClaudeCodeEngine, deps: ExtraEnginesDeps): ExtraEngines {
  const available = engine.available
  return {
    ids: available ? ['claude-code'] : [],
    backends: available ? { 'claude-code': engine.backend } : {},
    // Smoke never spawns Claude Code for a quick call.
    quick:
      available && !deps.smoke
        ? {
            'claude-code': claudeQuickEngine({
              ready: async () => {
                const { claudeCode } = engine.status()
                return claudeCodeReady(claudeCode) ? { ok: true } : { ok: false, reason: claudeCode.detail }
              },
              run: async (args, input, signal) => {
                const cli = await engine.cli()
                if (!cli) throw new Error('Claude Code was not found.')
                return spawnClaudeOnce(cli.path, args, input, { env: childEnv(process.env, null, deps.home), cwd: deps.dataDir, signal })
              },
            }),
          }
        : {},
    services: {
      claudeCode: {
        recheck: () => engine.recheck(),
        openSignIn: () => engine.openSignIn(),
        chooseCli: async () => {
          const path = await deps.pickFile({ title: mainT('engines.core.mainIndex.chooseTheClaudeProgram'), message: mainT('engines.core.mainIndex.chooseTheClaudeProgram2'), defaultPath: deps.home })
          if (!path) return null
          if (!isExecutableFile(path)) throw new Error(`That file isn’t a program ${BRAND_NAME} can run. Choose the claude program itself.`)
          deps.updateSettings({ claudeCodePath: path })
          return engine.recheck()
        },
        updateCli: async (options) => {
          const result = await engine.updateCli(options?.model ?? null)
          if (result.outcome !== 'updated' || !options?.chatId) return result
          // New enough now: the message that failed goes again, on the updated CLI.
          try {
            deps.retry(options.chatId)
            return { ...result, retried: true }
          } catch (err) {
            console.warn(`${BRAND_NAME} could not send the message again after updating Claude Code:`, err)
            return result
          }
        },
      },
    },
    status: () => engine.status(),
    summaries: () => (available ? [engine.summary()] : []),
    processes: () => engine.processes,
    route: (chatId) => (available ? engine.backend.route(chatId) : null),
    settingsChanged: (next, previous) => engine.settingsChanged(next, previous),
    claudeProgram: () => engine.program(),
    start: async () => undefined,
    dispose: () => engine.dispose(),
  }
}

/**
 * The smoke run's engine: hidden, or the offline stand-in CLI when asked for
 * (never the real `claude`). It answers only --version and auth status: no
 * chat in the smoke run uses Claude Code.
 */
function smokeEngine(appRoot: string): Partial<ClaudeCodeEngineDeps> {
  const fake = join(appRoot, FAKE_CLAUDE)
  if (process.env.ATELIER_SMOKE_FAKE_CLAUDE !== '1' || !existsSync(fake)) return { available: false }
  // Only the stand-in is runnable, and no shell is asked, so the run never touches a real install (not even its --version).
  return { available: true, env: { ...process.env, ATELIER_CLAUDE_PATH: fake, FAKE_CLAUDE_AUTH: process.env.FAKE_CLAUDE_AUTH ?? 'out' }, isExecutable: (path) => path === fake, shell: async () => null }
}

const updateOptions = z.object({ chatId: z.string().min(1).max(200).optional(), model: z.string().min(1).max(200).optional() }).strict().optional()

/** The claudeCode service's argument schemas. */
export const EXTRA_SERVICE_SCHEMAS = {
  claudeCode: {
    recheck: z.tuple([]),
    openSignIn: z.tuple([]),
    chooseCli: z.tuple([]),
    updateCli: z.tuple([updateOptions]),
  },
}

export const EXTRA_SMOKE_SHOTS: readonly ShotSpec[] = [
  {
    // ST-58: both engines to choose from, and Claude Code's status with Sign in (opens Terminal) and Re-check.
    // Only with ATELIER_SMOKE_FAKE_CLAUDE=1, which puts the offline stand-in CLI behind the engine.
    name: 'd-settings-model-engines',
    async run(ctx) {
      const status = await ctx.chrome.invoke<EngineStatus>('engine', 'status')
      if (!status.claudeCodeAvailable) return
      ctx.tabs.openInternal('atelier://settings/model')
      await ctx.chrome.until(`return document.querySelectorAll('.mk-choices [role="radio"]').length === 2 && document.querySelector('.mk-card')?.textContent.includes('9.9.9')`, 10_000, 'the engine choice and Claude Code status')
      await new Promise((r) => setTimeout(r, 500))
      await ctx.shot('d-settings-model-engines')
    },
  },
]
