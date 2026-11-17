/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SettingsView } from '@shared/ipc'
import { atelier } from '../api'
import { playCue } from '../ui/audio'
import { createChatSounds } from '../ui/sounds'

// NS-03's wiring: one subscription to every chat's agent events in this
// window, playing a cue when `chatSounds` is on. Main sends the matching
// notifications silent meanwhile (chatNotificationSilent).

let started = false

export function startChatSounds(): void {
  if (started) return
  started = true
  let settings: Pick<SettingsView, 'chatSounds'> = atelier.initial.settings
  atelier.onAppEvent((event) => {
    if (event.type === 'settings') settings = event.view
  })
  const sounds = createChatSounds({ enabled: () => settings.chatSounds === true, play: playCue, now: () => Date.now() })
  atelier.agent.onEvent((event, meta) => void sounds.onEvent(meta.chatId, event))
}
