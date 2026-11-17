/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { Companion } from '@shared/services'
import { useComposerHandle } from './composer/DropZone'
import type { ClosingAsk } from './logic/askBlock'
import { QuestionBlock } from './RequestBlocks'
import type { ChatState } from './store'

// DS-63's question block under a finished reply that ends by asking you
// something: Answer by voice or type, through the composer. The question was
// lifted out of the reply's text (closingAsk), so it shows once, as the
// turn's last content block. It locks once you send or while a reply streams.

export function TurnQuestion({ ask, state, companion }: { ask: ClosingAsk; state: ChatState; companion: Companion | null | undefined }): ReactElement {
  const composer = useComposerHandle()
  const running = state.log.status !== 'idle'
  return <QuestionBlock companion={companion} question={ask.question} detail={ask.detail ?? undefined} composer={composer} locked={running || state.sentAt !== null} />
}
