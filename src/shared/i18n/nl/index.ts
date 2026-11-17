/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Dutch catalogue: one fragment per English area, each a subset of
// that area's keys (`Dutch<typeof en>`). A key Dutch lacks shows English and
// is logged once (core.ts). tests/i18nParity.test.ts checks keys, placeholders
// and plural forms against English; every fragment covers all its area's keys.
import type { MessageKey } from '../en'
import { address } from './address'
import { agent } from './agent'
import { atWork } from './atWork'
import { autofill } from './autofill'
import { chat } from './chat'
import { chatTools } from './chatTools'
import { coCard } from './coCard'
import { composer } from './composer'
import { connectors } from './connectors'
import { core } from './core'
import { diagnostics } from './diagnostics'
import { downloads } from './downloads'
import { extensions } from './extensions'
import { files } from './files'
import { firstRun } from './firstRun'
import { float } from './float'
import { intake } from './intake'
import { capture } from './meetingCapture'
import { meetings } from './meetings'
import { memory } from './memory'
import { menus } from './menus'
import { migrations } from './migrations'
import { galleries } from './galleries'
import { native } from './native'
import { passwords } from './passwords'
import { platform } from './platform'
import { profiles } from './profiles'
import { safety } from './safety'
import { settings } from './settings'
import { sites } from './sites'
import { skills } from './skills'
import { speech } from './speech'
import { system } from './system'
import { tabs } from './tabs'
import { updates } from './updates'
import { voice } from './voice'
import { workspace } from './workspace'
import { newTabSearch } from './newTabSearch'
import { privacyPack } from './privacyPack'
import { extImport } from './extImport'
import { media } from './media'
import { tweaks } from './tweaks'
import { packs } from './packs'
import { reader } from './reader'
import { translate } from './translate'
import { decisions } from './decisions'
import { permissionsHub } from './permissionsHub'
// The engines a build adds besides the API key (empty from the public stubs).
import { engines } from '@internal/engines/i18n/nl'

/** Every Dutch fragment, under the same area names as EN_FRAGMENTS. */
export const NL_FRAGMENTS = {
  core,
  address,
  tabs,
  sites,
  safety,
  menus,
  downloads,
  chat,
  atWork,
  settings,
  speech,
  passwords,
  autofill,
  voice,
  meetings,
  capture,
  float,
  intake,
  composer,
  files,
  connectors,
  extensions,
  profiles,
  agent,
  chatTools,
  skills,
  memory,
  workspace,
  platform,
  firstRun,
  updates,
  diagnostics,
  migrations,
  system,
  native,
  coCard,
  galleries,
  newTabSearch,
  privacyPack,
  extImport,
  media,
  tweaks,
  packs,
  reader,
  translate,
  permissionsHub,
  decisions,
  engines,
} as const

export const NL = Object.assign({}, ...Object.values(NL_FRAGMENTS)) as Readonly<Partial<Record<MessageKey, string>>>
