/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { native as en } from '../en/native'
import type { Dutch } from './types'

// Dutch for the native.* strings: every English key, in English order.
export const native = {
  'native.haptics.section': 'Trackpad',
  'native.haptics.row': 'Haptische feedback op het trackpad',
  'native.haptics.description': 'Een lichte tik onder je vinger wanneer een gesplitste weergave op de helft of een derde uitlijnt.',
  'native.lid.section': 'Deksel en sluimer',
  'native.lid.row': 'Pauzeer opnemen terwijl het deksel dicht is',
  'native.lid.description': 'Een vergaderopname pauzeert wanneer je het deksel sluit of de Mac gaat sluimeren, en gaat verder wanneer je hem opent. Een pauze die je zelf hebt ingesteld, blijft staan.',
  'native.lid.rowSleep': 'Pauzeer opnemen terwijl de computer sluimert',
  'native.lid.descriptionSleep': 'Een vergaderopname pauzeert wanneer de computer gaat sluimeren, en gaat verder wanneer hij ontwaakt. Een pauze die je zelf hebt ingesteld, blijft staan.',
  'native.lid.paused': 'Gepauzeerd terwijl het deksel dicht is',
  'native.lid.pausedBody': 'Je vergaderopname gaat verder wanneer je het deksel opent.',
  'native.lid.pausedSleep': 'Gepauzeerd terwijl de computer sluimert',
  'native.lid.pausedSleepBody': 'Je vergaderopname gaat verder wanneer de computer ontwaakt.',
} as const satisfies Dutch<typeof en>
