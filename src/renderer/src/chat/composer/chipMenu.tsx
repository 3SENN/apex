/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSetup } from '@shared/chats'
import { t } from '@shared/i18n/core'
import type { Companion } from '@shared/services'
import type { PopoverItem } from '../../ui/MenuList'
import { CompanionAvatar } from '../CompanionAvatar'
import { CHAT_MODELS, EFFORTS, hasEffortControl, modelLabel } from '../logic/composer'

// The composer chip's menu (CH-07, DS-125) on the shared in-window popover
// (DS-94): a companion search, companions with a 22 px face and a check on
// the current one, then (behind the "Model and effort" switch) the model and
// effort presets with a check, or a lock once the chat has started, and
// Manage companions. The switch is remembered per viewer.

const ADVANCED_KEY = 'apex.composer.chipAdvanced'

export function chipAdvanced(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_KEY) !== '0'
  } catch {
    return true
  }
}

export function setChipAdvanced(on: boolean): void {
  try {
    window.localStorage.setItem(ADVANCED_KEY, on ? '1' : '0')
  } catch {
    // Private windows and blocked storage: the switch just isn't remembered.
  }
}

/**
 * `act` is the chat's "act without asking" mode (CH-18), shown as a switch row
 * (DS-125: Apex's options live here, not as a control-row button); null hides it.
 */
export function chipMenuItems(input: { companions: readonly Companion[]; companionId: string; setup: ChatSetup | null; advanced: boolean; act?: boolean | null; /** Only the models (an error card's Use another model); a started chat's pick goes to a new chat. */ models?: boolean }): PopoverItem[] {
  const { companions, companionId, setup, advanced, act = null } = input
  const fixed = setup?.fixed ?? false
  if (input.models && setup) {
    return [
      { id: 'model-heading', kind: 'header', label: fixed ? t('composer.chipMenu.newChatWith') : t('composer.chipMenu.model') },
      ...CHAT_MODELS.map((m): PopoverItem => {
        const current = m.id === setup.model
        return { id: `model:${m.id}`, label: m.label, checked: current, keywords: 'model', ...(current ? { trailing: 'check' as const, ...(fixed ? { disabled: true } : {}) } : {}) }
      }),
    ]
  }
  const items: PopoverItem[] = [
    { id: 'heading', kind: 'header', label: fixed ? t('composer.chipMenu.continueWith') : t('composer.chipMenu.who') },
    ...companions.map((c): PopoverItem => ({
      id: `companion:${c.id}`,
      label: c.name,
      icon: <CompanionAvatar companion={c} size={22} label="" />,
      checked: c.id === companionId,
      strong: c.id === companionId,
      ...(c.id === companionId ? { trailing: 'check' as const } : {}),
    })),
  ]
  if (setup && advanced) {
    const lock = fixed ? { trailing: 'lock' as const, disabled: true, title: t('composer.chipMenu.fixed') } : {}
    items.push({ id: 'sep-model', kind: 'separator', label: '' }, { id: 'model-heading', kind: 'header', label: t('composer.chipMenu.model') })
    for (const m of CHAT_MODELS) {
      const current = m.id === setup.model
      if (fixed && !current) continue
      items.push({ id: `model:${m.id}`, label: m.label, checked: current, keywords: 'model', ...(current && !fixed ? { trailing: 'check' as const } : {}), ...lock })
    }
    items.push({ id: 'effort-heading', kind: 'header', label: t('composer.chipMenu.effort') })
    if (!hasEffortControl(setup.model)) {
      items.push({ id: 'effort-note', label: t('composer.chipMenu.noEffort', { model: modelLabel(setup.model) }), disabled: true, keywords: 'effort' })
    } else {
      for (const e of EFFORTS) {
        const current = e.id === setup.effort
        if (fixed && !current) continue
        items.push({ id: `effort:${e.id}`, label: e.label, checked: current, keywords: 'effort', ...(current && !fixed ? { trailing: 'check' as const } : {}), ...lock })
      }
    }
  }
  items.push({ id: 'sep-switch', kind: 'separator', label: '' })
  if (act !== null) items.push({ id: 'act', kind: 'switch', label: t('chat.mode.act'), description: t('chat.mode.note'), checked: act })
  items.push(
    { id: 'advanced', kind: 'switch', label: t('composer.chipMenu.advanced'), description: t('composer.chipMenu.advancedHint'), checked: advanced },
    { id: 'manage', label: t('composer.chipMenu.manage') },
  )
  return items
}
