/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Companion, CompanionLook } from '@shared/companion'
import { lookKey } from '@shared/companionLogic'
import { useCompanionAssets, usePresets } from '../components/companionData'
import { shuffledLook, useSavedLook, type LookBinding } from '../pages/CompanionEditor'
import { t } from '../i18n/useT'
import { cx, showMenu } from '../ui'
import { useReportSave } from './CardSaves'
import { LookRing } from './LookRing'
import { LookTools } from './LookTools'

// Look editing inside the hero (DS-43): the figure stays centred and grows
// ×1.34, with one hairline toolbar pill at the top-left (undo, redo, a
// divider and the four one-shot shuffle styles), the ring of category
// bubbles around the figure (DS-118) and the floating option card a bubble
// opens at the hero's edge (DS-119). Every change saves as it is made,
// through the card's floating save pill.

interface LookInPlaceProps {
  companion: Companion
  /** The exit is playing: the panel fades quickly before it unmounts. */
  leaving: boolean
  /** The look on show while editing (null when done), so the hero figure previews it. */
  onPreview(look: CompanionLook | null): void
}

function onHistoryKey(e: KeyboardEvent<HTMLElement>, binding: LookBinding): void {
  const mod = e.metaKey || e.ctrlKey
  if (!mod || e.key.toLowerCase() !== 'z' || (e.target instanceof HTMLInputElement && e.target.type === 'text')) return
  e.preventDefault()
  if (e.shiftKey) binding.redo()
  else binding.undo()
}

export function LookInPlace({ companion, leaving, onPreview }: LookInPlaceProps): ReactElement {
  const [loaded, retry] = useCompanionAssets()
  const assets = loaded instanceof Error ? null : loaded
  const binding = useSavedLook(companion, assets)
  const presets = usePresets()
  const preview = useRef(onPreview)
  preview.current = onPreview
  useReportSave(binding.save?.state ?? 'idle', binding.save?.retry)

  const key = lookKey(binding.look)
  useEffect(() => preview.current(binding.look), [key])
  useEffect(() => () => preview.current(null), [])

  const pickPreset = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(presets.map((p) => ({ id: p.id, label: p.name })), anchor)
    const preset = presets.find((p) => p.id === choice)
    if (preset) binding.set({ ...preset.look })
  }

  return (
    <div className={cx('co-look', leaving && 'co-look--leaving')} onKeyDown={(e) => onHistoryKey(e, binding)}>
      <LookTools binding={binding} label={t('settings.look.toolbar')} canShuffle={assets !== null} onShuffle={(style) => assets && binding.set(shuffledLook(assets, style))}>
        {presets.length > 0 && (
          <button type="button" className="co-look__style" aria-haspopup="menu" onClick={(e) => void pickPreset(e.currentTarget)}>
            {t('settings.look.presets')} <ChevronDown aria-hidden />
          </button>
        )}
      </LookTools>
      <LookRing binding={binding} assets={assets} loadError={loaded instanceof Error ? loaded : null} onRetry={retry} />
    </div>
  )
}

