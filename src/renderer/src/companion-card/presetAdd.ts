/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Adding a preset as a companion, shared by the preset detail sheet
// and the preset gallery and profile (atelier://presets[/<id>]). The new
// companion owns the preset's starter skills; starter routines arrive paused
// for you to review. Also the profile's stat tiles.
import { useCallback, useState } from 'react'
import type { Companion } from '@shared/companion'
import type { PresetDetail } from '@shared/onboarding'
import { t } from '@shared/i18n/core'
import { chatUrl } from '@shared/url'
import { atelier, call, errorText } from '../api'

export type PresetAddState = { kind: 'idle' } | { kind: 'preparing' } | { kind: 'added'; companion: Companion } | { kind: 'failed'; message: string }

/** Creates the companion, then saves its starter skills and its starter routines (paused). */
export async function addPresetCompanion(detail: Pick<PresetDetail, 'presetId' | 'starterSkills' | 'starterRoutines'>): Promise<Companion> {
  const companion = await call('companions', 'create', { presetId: detail.presetId })
  await Promise.all([
    ...detail.starterSkills.map((s) => call('skills', 'save', { ...s, owner: companion.id }).catch(() => undefined)),
    ...detail.starterRoutines.map((r) => call('routines', 'save', { ...r, companionId: companion.id, enabled: false }).catch(() => undefined)),
  ])
  return companion
}

/** The add flow's state: preparing while it runs, then added (or failed, to try again). */
export function usePresetAdd(onAdded?: (companion: Companion) => void): {
  state: PresetAddState
  add(detail: PresetDetail): Promise<void>
  startChat(companion: Companion): Promise<boolean>
} {
  const [state, setState] = useState<PresetAddState>({ kind: 'idle' })
  const add = useCallback(
    async (detail: PresetDetail): Promise<void> => {
      setState({ kind: 'preparing' })
      try {
        const companion = await addPresetCompanion(detail)
        setState({ kind: 'added', companion })
        onAdded?.(companion)
      } catch (err) {
        setState({ kind: 'failed', message: errorText(err) })
      }
    },
    [onAdded],
  )
  const startChat = useCallback(async (companion: Companion): Promise<boolean> => {
    try {
      const chatId = await atelier.agent.start(t('galleries.presets.greeting', { name: companion.name }), { companionId: companion.id })
      await call('pages', 'open', chatUrl(chatId))
      return true
    } catch (err) {
      setState({ kind: 'failed', message: errorText(err) })
      return false
    }
  }, [])
  return { state, add, startChat }
}

export { companionFromPreset, presetStats, routineSkill, type PresetStatId } from './logic/presetProfile'
