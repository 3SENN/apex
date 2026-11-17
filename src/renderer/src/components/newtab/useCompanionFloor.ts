/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useState } from 'react'
import { apex, errorText } from '../../api'
import { useSettingsView } from '../../companion-card/useLoaded'
import { toast } from '../../ui'
import { floorShown, takeLegacyFloorSetting } from './newtabLogic'

/**
 * DS-75b: "Companions on New Tab", the profile setting every start surface
 * (new tabs, empty chats) follows. A change from any of them, or from
 * Settings › Appearance, reaches the others through the settings broadcast;
 * the toggle answers at once and settles on what settings say.
 */
export function useCompanionFloor(): { on: boolean; toggle(): void } {
  const settings = useSettingsView()
  const [pending, setPending] = useState<boolean | null>(null)
  const stored = floorShown(settings)

  // A window that remembered "off" before this was a setting hands it over once.
  useEffect(() => {
    if (takeLegacyFloorSetting() === false) void apex.settings.set({ companionFloor: false }).catch(() => undefined)
  }, [])
  useEffect(() => setPending(null), [stored])

  const on = pending ?? stored
  const toggle = useCallback(() => {
    const next = !on
    setPending(next)
    apex.settings.set({ companionFloor: next }).catch((err: unknown) => {
      setPending(null)
      toast.show({ message: errorText(err), tone: 'error' })
    })
  }, [on])
  return { on, toggle }
}
