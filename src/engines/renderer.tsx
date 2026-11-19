/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@engines/renderer`: the Claude subscription engine in the interface
// (ST-58, ST-59).
import { SquareTerminal } from 'lucide-react'
import { t } from '@shared/i18n/core'
import type { EngineUi } from '../../src/renderer/src/engines/seam'
import { ClaudeCodeSections, ClaudeCodeSetup, useClaudeCodeErrorStep } from './claude-code/renderer/ClaudeCode'

export const ENGINE_UI: EngineUi = {
  choices: [
    {
      id: 'claude-code',
      icon: <SquareTerminal />,
      get description() {
        return t('engines.settings.modelAndKey.yourCompanionsRunThrough')
      },
    },
  ],
  Sections: ClaudeCodeSections,
  Welcome: ClaudeCodeSetup,
  useErrorStep: useClaudeCodeErrorStep,
}
