/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A recognition-language select (ST-18): the system language first, then the
// languages recognised on this Mac, then those that use Apple's servers, so
// it is clear which ones send audio away. The secondary select (the
// second language meetings listen in) starts with Automatic, the Mac's next
// language, then One language only.
import type { ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { NO_SECOND_LOCALE, findLocale, resolveLocale, secondLocale, type SpeechLocale, type SpeechLocaleList } from '@shared/speech'
import { Select, type SelectGroup, type SelectOption } from '../ui'
import { groupLocales } from './logic'

/** The select's value for "no choice" (the system language, or none). */
export const NO_LOCALE = ''

export interface LanguageSelectProps {
  id?: string
  value: string | null
  list: { system: string; items: readonly SpeechLocale[]; preferred?: SpeechLocaleList['preferred'] }
  onChange(value: string | null): void
  /** 'primary' offers the system language; 'secondary' offers Automatic and One language only. */
  kind: 'primary' | 'secondary'
  /** The secondary's first language, so Automatic can name the other one. */
  primary?: string | null
  disabled?: boolean
  label: string
}

export function LanguageSelect({ id, value, list, onChange, kind, disabled = false, label, primary = null }: LanguageSelectProps): ReactElement {
  const groups = groupLocales(list.items)
  const system = resolveLocale(null, list)
  const automatic = kind === 'secondary' ? secondLocale(null, primary ?? system?.id ?? list.system, { items: [...list.items], preferred: list.preferred ?? [] }) : null
  const options: Array<SelectOption<string> | SelectGroup<string>> =
    kind === 'primary'
      ? [{ value: NO_LOCALE, label: t('speech.locale.system', { name: system?.name ?? list.system }) }]
      : [
          { value: NO_LOCALE, label: automatic ? t('speech.locale.automaticSecond', { name: automatic.name }) : t('speech.locale.automaticNone') },
          { value: NO_SECOND_LOCALE, label: t('speech.locale.oneLanguage') },
        ]
  if (groups.onDevice.length) options.push({ label: t('speech.locale.groupOnDevice'), options: groups.onDevice.map((l) => ({ value: l.id, label: l.name })) })
  if (groups.server.length) options.push({ label: t('speech.locale.groupServer'), options: groups.server.map((l) => ({ value: l.id, label: l.name })) })
  // A saved language this Mac no longer lists stays visible.
  const saved = value ? (findLocale(list.items, value)?.id ?? value) : NO_LOCALE
  if (saved !== NO_LOCALE && saved !== NO_SECOND_LOCALE && !findLocale(list.items, saved)) options.push({ value: saved, label: saved })
  return <Select id={id} value={saved} options={options} onChange={(v) => onChange(v === NO_LOCALE ? null : v)} disabled={disabled} aria-label={label} />
}
