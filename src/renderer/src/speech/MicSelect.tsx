/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The microphone select (ST-18): built-in, the system default or any input,
// with a refresh for devices plugged in since. A saved device that isn't
// connected stays listed and the owner shows the fallback notice.
import type { ReactElement, Ref } from 'react'
import { RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n/core'
import type { AudioInputDevice, MicChoice } from '@shared/speech'
import { IconButton, Select, Spinner } from '../ui'
import { micOptions } from './logic'

export interface MicSelectProps {
  id?: string
  value: MicChoice
  devices: readonly AudioInputDevice[]
  onChange(value: MicChoice): void
  onRefresh(): void
  refreshing?: boolean
  disabled?: boolean
  selectRef?: Ref<HTMLSpanElement>
}

export function MicSelect({ id, value, devices, onChange, onRefresh, refreshing = false, disabled = false, selectRef }: MicSelectProps): ReactElement {
  const options = micOptions(devices, value).map((o) => ({
    value: o.value,
    label: o.value === 'built-in' ? t('speech.mic.builtIn') : o.value === 'system' ? t('speech.mic.system') : o.missing ? (o.name ? t('speech.mic.missing', { name: o.name }) : t('speech.mic.unknown')) : (o.name ?? o.value),
  }))
  return (
    <span className="sk-inline" ref={selectRef}>
      <Select id={id} value={value} options={options} onChange={onChange} disabled={disabled} aria-label={t('speech.mic.title')} />
      <IconButton label={t('speech.mic.refresh')} icon={refreshing ? <Spinner size={14} /> : <RefreshCw />} size="sm" disabled={refreshing || disabled} onClick={onRefresh} />
    </span>
  )
}
