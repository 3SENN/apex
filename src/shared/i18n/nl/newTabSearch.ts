/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { newTabSearch as en } from '../en/newTabSearch'
import type { Dutch } from './types'

// Dutch for the newTabSearch.* strings: every English key, in English order.
export const newTabSearch = {
  'newTabSearch.mode.label': 'Vragen of op het web zoeken',
  'newTabSearch.mode.ask': 'Vraag {name}',
  'newTabSearch.mode.web': 'Zoek op het web met {engine}',
  'newTabSearch.placeholder': 'Zoek met {engine} of typ een site',
  'newTabSearch.label': 'Zoek met {engine} of ga naar een site',
  'newTabSearch.action.go': 'Ga naar {host}',
  'newTabSearch.action.search': 'Zoek met {engine}',
  'newTabSearch.action.ask': 'Vraag {name}',
  'newTabSearch.list': 'Acties en suggesties',
  'newTabSearch.choose.title': 'Zoek op het web met',
  'newTabSearch.choose.hint': 'Je kunt dit later wijzigen in Instellingen › Zoeken.',
  'newTabSearch.choose.keep': '{engine} houden',
  'newTabSearch.choose.label': 'Kies een zoekmachine',
} as const satisfies Dutch<typeof en>
