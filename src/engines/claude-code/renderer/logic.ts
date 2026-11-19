/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Words for Claude Code's status in Settings › Model and key, the welcome
// step and its error cards (ST-58, ST-59). Pure, so the wording is tested once.
import { modelName } from '@shared/chatErrors'
import { t, type MessageKey } from '@shared/i18n/core'
import type { ClaudeCodeStatus, CliInstall, CliSource, CliUpdateStatus, RateLimitNote } from '../shared/status'

/** Same values as BadgeTone in ui/indicators.tsx. */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'info'

export function claudeBadge(status: ClaudeCodeStatus): { tone: StatusTone; label: string } {
  switch (status.state) {
    case 'checking':
      return { tone: 'neutral', label: t('settings.engine.checking') }
    case 'ready':
      return { tone: 'success', label: t('settings.engine.ready') }
    case 'signed-out':
      return { tone: 'warning', label: t('engines.settings.engine.notSignedIn') }
    case 'not-found':
      return { tone: 'warning', label: t('engines.settings.engine.notFound') }
    case 'unknown':
      return { tone: 'info', label: t('engines.settings.engine.found') }
  }
}

const SOURCES: Record<CliSource, string> = {
  get override() { return t('engines.settings.engine.theLocationYouChose') },
  environment: 'ATELIER_CLAUDE_PATH',
  get bundled() { return t('engines.settings.engine.theCopyThatComes') },
  get 'login-shell'() { return t('engines.settings.engine.yourShellSPath') },
  get 'common-path'() { return t('engines.settings.engine.aUsualInstallFolder') },
}

export function sourceLabel(source: CliSource | null): string {
  return source ? SOURCES[source] : ''
}

/** "Version 2.1.266, found in your shell’s PATH." */
export function cliLine(status: ClaudeCodeStatus): string {
  if (status.state === 'checking' && !status.path) return t('engines.settings.engine.lookingForClaudeCode')
  if (!status.path) return status.detail
  const version = status.version ? t('engines.settings.engine.version', { version: status.version }) : t('engines.settings.engine.installed')
  return t('engines.settings.engine.from', { version, value: sourceLabel(status.source) })
}

export function accountLine(status: ClaudeCodeStatus): string {
  if (status.state !== 'ready') return status.detail
  if (status.account === 'subscription') return t('engines.settings.engine.signedInWithYour')
  if (status.account === 'api-key') return t('engines.settings.engine.signedInWithAn')
  if (status.account === 'other') return t('engines.settings.engine.signedInThroughThe')
  return t('engines.settings.engine.signedIn')
}

/** The account limit Claude Code reported, while it matters; null otherwise. */
export function limitLine(note: RateLimitNote | null, formatTime: (ms: number) => string): string | null {
  if (!note) return null
  const until = note.resetsAt ? t('engines.settings.engine.untilTime', { time: formatTime(note.resetsAt) }) : ''
  return note.status === 'limited'
    ? t('engines.settings.engine.atItsLimit', { until })
    : t('engines.settings.engine.yourClaudeAccountIs', { until })
}

/** Whether the page should look again when Atelier comes back to the front (after signing in, or updating, in Terminal). */
export function shouldRecheckOnFocus(status: ClaudeCodeStatus): boolean {
  return status.state === 'signed-out' || status.state === 'not-found' || status.state === 'unknown' || status.update?.phase === 'manual' || status.tooOld != null
}

/** One found install: "2.1.316 · a usual install folder". */
export function installLine(install: CliInstall): string {
  return `${install.version ?? t('engines.settings.engine.versionUnknown')} · ${sourceLabel(install.source)}`
}

/** "Update available: your Claude Code (2.1.266) is too old for Opus 5.5, which needs 2.1.280 or newer." Null when it isn't. */
export function tooOldLine(status: ClaudeCodeStatus): string | null {
  if (!status.tooOld || !status.version) return null
  return t('engines.settings.engine.tooOld', { version: status.version, model: modelName(status.tooOld.model), required: status.tooOld.required })
}

/** Update Claude Code's progress in Settings; null before it starts. */
export function updateStatusLine(update: CliUpdateStatus | null | undefined): { text: string; busy: boolean; tone: 'info' | 'success' | 'warning' } | null {
  switch (update?.phase ?? 'idle') {
    case 'idle':
      return null
    case 'updating':
    case 'opening-terminal':
      return { text: t('engines.settings.engine.update.updating'), busy: true, tone: 'info' }
    case 'checking':
      return { text: t('engines.settings.engine.update.checking'), busy: true, tone: 'info' }
    case 'updated':
      return { text: t('engines.settings.engine.update.updated', { version: update?.to ?? '' }), busy: false, tone: 'success' }
    case 'still-old':
      return { text: t('engines.settings.engine.update.stillOld', { version: update?.to ?? '?', required: update?.required ?? '?' }), busy: false, tone: 'warning' }
    case 'manual':
      return { text: t('engines.settings.engine.update.manual', { command: update?.command ?? '' }), busy: false, tone: 'info' }
    case 'failed':
      return { text: t('engines.settings.engine.update.failed', { detail: update?.detail ?? '' }), busy: false, tone: 'warning' }
  }
}


/** The update's progress line on a cc-too-old card; null before it starts. */
export function updateLine(update: CliUpdateStatus | null | undefined): { key: MessageKey; vars: Record<string, string>; tone: 'busy' | 'done' | 'problem' | 'info' } | null {
  if (!update) return null
  switch (update.phase) {
    case 'idle':
      return null
    case 'updating':
    case 'opening-terminal':
      return { key: 'engines.chat.error.update.updating', vars: {}, tone: 'busy' }
    case 'checking':
      return { key: 'engines.chat.error.update.checking', vars: {}, tone: 'busy' }
    case 'updated':
      return { key: 'engines.chat.error.update.updated', vars: { version: update.to ?? '' }, tone: 'done' }
    case 'still-old':
      return { key: 'engines.chat.error.update.stillOld', vars: { version: update.to ?? '?', required: update.required ?? '?' }, tone: 'problem' }
    case 'manual':
      return { key: 'engines.chat.error.update.manual', vars: { command: update.command ?? '' }, tone: 'info' }
    case 'failed':
      return { key: 'engines.chat.error.update.failed', vars: { detail: update.detail ?? '' }, tone: 'problem' }
  }
}
