/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompanionEffort } from '@shared/companion'
import { t } from '@shared/i18n/core'

// Model and effort choices for a companion's new chats. The ids mirror
// MODELS in src/main/settings.ts, which validates whatever is saved.

export const MODEL_CHOICES = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'recommended' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'faster' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'fastest' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'most capable' },
] as const

export const EFFORT_CHOICES: ReadonlyArray<{ id: CompanionEffort; label: string }> = [
  { id: 'low', get label() { return t('coCard.models.low') } },
  { id: 'medium', get label() { return t('coCard.models.medium') } },
  { id: 'high', get label() { return t('coCard.models.high') } },
  { id: 'xhigh', get label() { return t('coCard.models.extraHigh') } },
  { id: 'max', get label() { return t('coCard.models.maximum') } },
]

export function modelLabel(id: string | null | undefined): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.label ?? (id || t('coCard.models.unknownModel'))
}

export function effortLabel(id: string | null | undefined): string {
  return EFFORT_CHOICES.find((e) => e.id === id)?.label ?? (id || t('coCard.models.unknown'))
}

export type DefaultSource = 'companion' | 'global'

/**
 * What a companion's next new chat starts with, and where each value comes
 * from: the companion's own default, else the global setting. A choice made
 * in the chat before its first message wins over both (main applies it).
 */
export function chatDefaults(companion: { model: string | null; effort: CompanionEffort | null }, global: { model: string; effort: string }): {
  model: string
  effort: string
  modelSource: DefaultSource
  effortSource: DefaultSource
} {
  return {
    model: companion.model ?? global.model,
    effort: companion.effort ?? global.effort,
    modelSource: companion.model ? 'companion' : 'global',
    effortSource: companion.effort ? 'companion' : 'global',
  }
}
