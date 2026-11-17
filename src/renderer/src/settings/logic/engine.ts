/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Words for the engine status in Settings › Model and key and the welcome
// flow (ST-58). Pure, so the wording is tested once for every surface. The
// engines a build adds bring their own words (`@internal/engines/renderer`).
import { engineHasOwnAccount, type EngineId, type EngineStatus } from '@shared/engine'
import { t } from '@shared/i18n/core'

/** Same values as BadgeTone in ui/indicators.tsx. */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'info'

export function keyBadge(state: EngineStatus['apiKey']['state']): { tone: StatusTone; label: string } {
  if (state === 'saved') return { tone: 'success', label: t('settings.engine.ready') }
  if (state === 'environment') return { tone: 'info', label: t('settings.engine.fromEnvironment') }
  return { tone: 'warning', label: t('settings.engine.needsAKey') }
}

export function engineBadge(status: EngineStatus, engine: EngineId): { tone: StatusTone; label: string } {
  if (engine === 'api-key') return keyBadge(status.apiKey.state)
  const id: string = engine
  const other = status.others.find((o) => o.id === id)
  return other ? { tone: other.tone, label: other.badge } : { tone: 'neutral', label: t('settings.engine.checking') }
}

/**
 * Whether a chat may send. The API key engine needs a key; a chat on an
 * engine with its own sign-in sends without one and reports a missing
 * install or sign-in in the chat. Pass the chat's setup engine (a draft's
 * shows what its first message would use).
 */
export function engineCanSend(engine: string | undefined, hasApiKey: boolean): boolean {
  return engineHasOwnAccount(engine) || hasApiKey
}
