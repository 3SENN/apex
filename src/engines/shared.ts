/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@engines/shared`: the Claude subscription engine (ST-58 to ST-60) on top
// of the API key, in every build (docs/claude-subscription.md). Pure: main
// and the renderer both read it.
import { z } from 'zod'
import { t } from '@shared/i18n/core'
import type { ClaudeCodeStatus, CliUpdateResult } from './claude-code/shared/status'

export const EXTRA_ENGINE_IDS = ['claude-code'] as const
export type ExtraEngineId = (typeof EXTRA_ENGINE_IDS)[number]

/** In the app language, read when shown. */
export const EXTRA_ENGINE_LABELS: Record<ExtraEngineId, string> = {
  get 'claude-code'() {
    return t('engines.menus.main.claudeCode')
  },
}

/** Claude Code's fields on EngineStatus. */
export interface ExtraEngineStatus {
  /** False in builds that hide the engine: only the API key is offered. */
  claudeCodeAvailable: boolean
  claudeCode: ClaudeCodeStatus
}

/** The claudeCode service namespace (src/shared/services.ts merges it). Changes also arrive as 'engine' events. */
export interface ExtraEngineServices {
  claudeCode: {
    /** Looks for Claude Code again and reads its version and sign-in. Never sends a message to a model. */
    recheck(): Promise<ClaudeCodeStatus>
    /** Opens Terminal running Claude Code so you sign in with your own Claude account. */
    openSignIn(): Promise<void>
    /** Picks the claude program with a file dialog and saves it as the path override; null when cancelled. */
    chooseCli(): Promise<ClaudeCodeStatus | null>
    /**
     * Update Claude Code: runs the chosen CLI's own `claude update` in the
     * background (progress in the status's `update`), reads the version again,
     * and opens Terminal with the right command when it can't update itself.
     * With `chatId`, the chat's last message goes again once the version is
     * new enough for `model`.
     */
    updateCli(options?: { chatId?: string; model?: string }): Promise<CliUpdateResult>
  }
}

/** Claude Code's chat error codes (SS-03). */
export const EXTRA_CHAT_ERROR_CODES = [
  'cc-signed-out',
  'cc-limit',
  'cc-missing',
  /** Claude Code is below the version the model (or the organization) needs. */
  'cc-too-old',
  /** Claude Code can't use the chat's model (not found, not allowed). */
  'cc-model',
] as const

/** Claude Code's app settings. */
export interface ExtraEngineSettings {
  /** Settings › Model and key: where the claude program is, when Atelier shouldn't look for it. */
  claudeCodePath: string | null
}

const absolutePath = z.string().trim().min(1).max(1024).regex(/^\//).refine((p) => !p.includes('\0')).nullable()

/** Registered with the other settings (src/shared/settingsRegistry.ts). */
export const EXTRA_ENGINE_SETTINGS = {
  claudeCodePath: { scope: 'app' as const, schema: absolutePath, default: null },
} as const
