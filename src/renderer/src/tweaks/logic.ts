/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { tweakParts, type Tweak, type TweakColor, type TweakFont } from '@shared/tweaks'
import { t, type MessageKey } from '@shared/i18n/core'

// Words for tweaks in the chrome (TWK-05): a tweak's summary line and the
// names of its fonts and colours, in the app language.

export const FONT_KEYS: Record<TweakFont, MessageKey> = {
  default: 'tweaks.font.default',
  sans: 'tweaks.font.sans',
  serif: 'tweaks.font.serif',
  mono: 'tweaks.font.mono',
  rounded: 'tweaks.font.rounded',
}

export function colorName(color: TweakColor): string {
  return t(`tweaks.color.${color}` as MessageKey)
}

/** "3 hidden · Serif · Focus · CSS", or that nothing is changed yet. */
export function tweakSummary(tweak: Pick<Tweak, 'hidden' | 'style' | 'css' | 'js' | 'jsEnabled'>): string {
  const p = tweakParts(tweak)
  const parts: string[] = []
  if (p.hidden > 0) parts.push(t('tweaks.summary.hidden', { count: p.hidden }))
  if (p.font) parts.push(t(FONT_KEYS[p.font]))
  if (p.tint) parts.push(t('tweaks.summary.tint'))
  if (p.accent) parts.push(t('tweaks.summary.accent'))
  if (p.focus) parts.push(t('tweaks.summary.focus'))
  if (p.css) parts.push(t('tweaks.summary.css'))
  if (p.js) parts.push(t('tweaks.summary.js'))
  return parts.length > 0 ? parts.join(' · ') : t('tweaks.summary.none')
}

/** Tweaks in a stable order for the list: by host, so a site is easy to find. */
export function sortTweaks<T extends Pick<Tweak, 'host'>>(tweaks: readonly T[]): T[] {
  return [...tweaks].sort((a, b) => a.host.localeCompare(b.host))
}
