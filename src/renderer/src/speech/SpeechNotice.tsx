/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A speech error or warning with its action: open the right Privacy pane,
// try again, or move focus to the language or microphone select.
import type { ReactElement } from 'react'
import { call } from '../api'
import { Notice } from '../settings/kit'
import { Button } from '../ui'
import { actionLabel, type SpeechCopy } from './errorCopy'

export interface SpeechNoticeProps {
  copy: SpeechCopy
  onRetry?(): void
  onChooseLanguage?(): void
  onChooseMic?(): void
  onDismiss?(): void
}

export function SpeechNotice({ copy, onRetry, onChooseLanguage, onChooseMic, onDismiss }: SpeechNoticeProps): ReactElement {
  const action = copy.action
  const run = (): void => {
    if (!action) return
    if (action.kind === 'open-settings') void call('speech', 'openPrivacySettings', action.pane)
    else if (action.kind === 'retry') onRetry?.()
    else if (action.kind === 'choose-language') onChooseLanguage?.()
    else onChooseMic?.()
  }
  const available = action && (action.kind === 'open-settings' || (action.kind === 'retry' && onRetry) || (action.kind === 'choose-language' && onChooseLanguage) || (action.kind === 'choose-mic' && onChooseMic))
  return (
    <Notice
      tone={copy.tone}
      onDismiss={onDismiss}
      action={
        available && action ? (
          <Button size="sm" variant="secondary" onClick={run}>
            {actionLabel(action)}
          </Button>
        ) : undefined
      }
    >
      {copy.message}
    </Notice>
  )
}
