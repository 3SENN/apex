/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { atelier } from '../api'

// The chrome's half of a voice command (MV-05): main says which chat the
// command went to, and the side panel opens on it. App mounts this once
// with its openPanel.
export function useVoicePanel(openPanel: (chatId: string) => void): void {
  useEffect(
    () =>
      atelier.onAppEvent((event) => {
        if (event.type === 'voice-open-chat') openPanel(event.chatId)
      }),
    [openPanel],
  )
}
