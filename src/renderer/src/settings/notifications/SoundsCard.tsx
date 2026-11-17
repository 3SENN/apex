/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Volume2 } from 'lucide-react'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { useT } from '../../i18n/useT'
import { Button } from '../../ui'
import { playCue, type CueSpec } from '../../ui/audio'
import type { ChatSound } from '../../ui/sounds'
import { Card, SwitchRow } from '../kit'
import '../../chat/chatTools.css'

// Settings › Notifications › Chat sounds (NS-03): the `chatSounds` switch and
// a preview of each cue. Done previews its three variants in turn, as the
// chat plays them. With chat sounds on, the matching notifications go silent.

const CUES: readonly ChatSound[] = ['needs-you', 'done', 'task-completed']

let doneVariant = 0

/** The cue a preview plays: done rotates through its variants like the chat does. */
export function previewCue(sound: ChatSound): CueSpec {
  return sound === 'done' ? { id: 'done', variant: doneVariant++ % 3 } : { id: sound }
}

export function SoundsCard({ settings, update }: { settings: Pick<SettingsView, 'chatSounds'>; update(patch: SettingsPatch): Promise<void> }): ReactElement {
  const t = useT()
  const on = settings.chatSounds === true
  return (
    <Card>
      <SwitchRow anchor="chat-sounds" label={t('chatTools.sounds.switch')} description={t('chatTools.sounds.description')} checked={on} onChange={(chatSounds) => void update({ chatSounds })} />
      <div className="sp-row cd-sounds__cues" role="group" aria-label={t('chatTools.sounds.title')}>
        {CUES.map((cue) => (
          <Button key={cue} size="sm" variant="secondary" icon={<Volume2 size={13} />} aria-label={t('chatTools.sounds.preview', { name: t(`chatTools.sounds.cue.${cue}`) })} onClick={() => playCue(previewCue(cue))}>
            {t(`chatTools.sounds.cue.${cue}`)}
          </Button>
        ))}
      </div>
    </Card>
  )
}
