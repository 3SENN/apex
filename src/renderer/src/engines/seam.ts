/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the renderer takes from `@engines/renderer`: the parts of the
// interface that belong to the engines besides the API key
// (src/shared/engine.ts): your Claude subscription (src/engines/renderer.tsx).
import type { ComponentType, ReactNode } from 'react'
import type { ChatErrorCode } from '@shared/chatErrors'
import type { EngineId, EngineStatus } from '@shared/engine'
import type { SettingsPatch, SettingsView } from '@shared/ipc'

/** An engine in Settings › Model and key's choice. */
export interface EngineChoiceSpec {
  id: EngineId
  icon: ReactNode
  description: string
}

export interface EngineSectionsProps {
  status: EngineStatus | null
  settings: SettingsView
  update(patch: SettingsPatch): void
}

export interface WelcomeEngineProps {
  settings: SettingsView
  onSettings(view: SettingsView): void
}

/** What an error card needs to offer an engine's own next step (an update, say). */
export interface EngineErrorStepArgs {
  code: ChatErrorCode
  /** The card offers the step (its action or secondary action is 'engine-step'). */
  offered: boolean
  chatId: string
  /** The chat's model, from the error's facts. */
  model: string | undefined
  /** The chat's newest item. */
  last: boolean
  /** When the error arrived in this session (null from the saved log). */
  arrivedAt: number | null
  onAct(): void
}

export interface EngineErrorStep {
  label: string
  icon: ReactNode
  /** The step is running; its button shows a spinner. */
  working: boolean
  run(): void
  /** How the step goes, under the card's text. */
  progress: { text: string; tone: 'busy' | 'done' | 'problem' | 'info' } | null
  /** The step handed over to something outside Atelier: Retry joins the actions and looks again first. */
  manual: boolean
  /** Looks again before a Retry after a manual step. */
  recheck(): Promise<unknown>
}

export interface EngineUi {
  /** The engines besides the API key, as choices. */
  choices: readonly EngineChoiceSpec[]
  /** Settings › Model and key's sections for those engines, under the choice. */
  Sections: ComponentType<EngineSectionsProps> | null
  /** The welcome flow's optional step for them. */
  Welcome: ComponentType<WelcomeEngineProps> | null
  /** An error card's engine step; null when the card's code has none. A hook. */
  useErrorStep(args: EngineErrorStepArgs): EngineErrorStep | null
}
