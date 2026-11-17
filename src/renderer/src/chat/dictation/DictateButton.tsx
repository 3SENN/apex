/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Mic, Square } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { IconButton, Spinner } from '../../ui'
import { DictationBar } from './DictationBar'
import { useDictation } from './useDictation'

// A small dictate control for any text field in the chrome (CH-11's rating
// note): a mic that turns into Stop while listening, with the same status
// line as the composer. The words go to `onText` once recognised.

export function DictateButton({ onText, label }: { onText(text: string): void; label?: string }): ReactElement | null {
  const t = useT()
  const dictation = useDictation(onText)
  if (!dictation.available) return null
  const stop = (): void => {
    void dictation.stop().then((text) => {
      if (text) onText(text)
    })
  }
  const busy = dictation.state === 'starting' || dictation.state === 'transcribing'
  return (
    <span className="dict-inline">
      {dictation.state === 'listening' ? (
        <IconButton size="sm" label={t('meetings.dictation.stop')} icon={<Square />} onClick={stop} />
      ) : (
        <IconButton size="sm" label={label ?? t('meetings.dictation.dictate')} icon={busy ? <Spinner size={12} /> : <Mic />} disabled={busy} onClick={() => void dictation.start()} />
      )}
      <DictationBar dictation={dictation} onStop={stop} className="dict-bar--inline" />
    </span>
  )
}
