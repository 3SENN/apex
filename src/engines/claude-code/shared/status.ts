/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the Claude subscription engine reports (ST-58 to ST-60): where the CLI is,
// whether it is signed in to the person's own Claude account, its version
// and Update Claude Code. These fields ride on EngineStatus
// (src/engines/shared.ts); every renderer surface reads them from there.

/**
 * Where Claude Code stands. 'checking' while a look-up runs; 'unknown' when
 * Atelier found it but could not tell whether it is signed in.
 */
export type ClaudeCodeState = 'checking' | 'not-found' | 'signed-out' | 'ready' | 'unknown'

/** How the CLI was found, in the order Atelier looks. */
export type CliSource = 'override' | 'environment' | 'bundled' | 'login-shell' | 'common-path'

/** How Claude Code signs in: a Claude subscription, an API key of its own, or something else (a cloud provider). */
export type ClaudeAccount = 'subscription' | 'api-key' | 'other'

export interface RateLimitNote {
  /** 'warning': close to the account's limit; 'limited': at it until `resetsAt`. */
  status: 'warning' | 'limited'
  /** Milliseconds since the epoch, when known. */
  resetsAt: number | null
  at: number
}

export interface ClaudeCodeStatus {
  state: ClaudeCodeState
  /** The binary Atelier runs, when found. */
  path: string | null
  source: CliSource | null
  /** For example '2.1.266'. */
  version: string | null
  account: ClaudeAccount | null
  /** One plain sentence about the state. */
  detail: string
  /** The exact next step while it isn't ready; null when ready. */
  nextStep: string | null
  /** The path override in Settings (or ATELIER_CLAUDE_PATH) points at nothing runnable. */
  overrideInvalid: boolean
  /** The last limit Claude Code reported for the account, while it matters. */
  rateLimit: RateLimitNote | null
  /** When the last look-up finished; 0 before the first. */
  checkedAt: number
  /** Every `claude` Atelier found, the one it runs marked; pinning one sets the path override. */
  installs: CliInstall[]
  /** The chosen CLI is below the minimum a model asked for in its last version error; null when it isn't. */
  tooOld: { model: string; required: string } | null
  /** Where Update Claude Code stands. */
  update: CliUpdateStatus
}

/** One `claude` on this Mac, with the version it reported (null when `--version` failed or took too long). */
export interface CliInstall {
  path: string
  source: CliSource
  version: string | null
  /** The one Atelier runs: the override when it is valid, else the highest version. */
  chosen: boolean
}

/**
 * Update Claude Code: `claude update` runs in the background, then Atelier reads
 * the version again. An install it can't update itself gets Terminal with the
 * right command instead ('manual').
 */
export type CliUpdatePhase = 'idle' | 'updating' | 'checking' | 'opening-terminal' | 'updated' | 'still-old' | 'manual' | 'failed'

export interface CliUpdateStatus {
  phase: CliUpdatePhase
  /** The version before the update. */
  from: string | null
  /** The version after it, once read. */
  to: string | null
  /** The minimum it has to reach, when a model named one. */
  required: string | null
  /** The latest line of output, or why it fell back to Terminal or failed. */
  detail: string | null
  /** The command Terminal runs ('manual'), or the one to run yourself ('failed'). */
  command: string | null
  at: number
}

export const IDLE_UPDATE: CliUpdateStatus = { phase: 'idle', from: null, to: null, required: null, detail: null, command: null, at: 0 }

/** Phases in which an update is still running. */
export function updateBusy(phase: CliUpdatePhase): boolean {
  return phase === 'updating' || phase === 'checking' || phase === 'opening-terminal'
}

/** What claudeCode.updateCli resolves with. 'updated' means the version is now new enough (the chat was sent again when asked). */
export interface CliUpdateResult {
  outcome: 'updated' | 'still-old' | 'manual' | 'failed'
  version: string | null
  required: string | null
  /** Main sent the chat's last message again. */
  retried: boolean
}

/** Whether Claude Code can run a chat now (found and signed in, or found with a sign-in Atelier couldn't read). */
export function claudeCodeReady(status: Pick<ClaudeCodeStatus, 'state'>): boolean {
  return status.state === 'ready' || status.state === 'unknown'
}

/**
 * Compares two CLI versions ('2.1.266', '2.1.280-beta.1'): negative when a is
 * older. Numbers compare as numbers; a pre-release is older than its release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: string } => {
    const [core = '', pre = ''] = v.trim().replace(/^v/i, '').split(/[-+]/, 2)
    return { parts: core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length, 3); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (d !== 0) return d
  }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}
