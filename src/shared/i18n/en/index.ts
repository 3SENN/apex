/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The English catalogue: one fragment per area. Keys are dotted and
// area-prefixed; tests/i18nKeys.test.ts
// fails on a key defined twice.
import { address } from './address'
import { chat } from './chat'
import { core } from './core'
import { menus } from './menus'
import { settings } from './settings'
import { sites } from './sites'
import { tabs } from './tabs'
import { safety } from './safety'
import { downloads } from './downloads'
import { atWork } from './atWork'
import { autofill } from './autofill'
import { float } from './float'
import { meetings } from './meetings'
import { capture } from './meetingCapture'
import { passwords } from './passwords'
import { speech } from './speech'
import { voice } from './voice'
import { composer } from './composer'
import { connectors } from './connectors'
import { extensions } from './extensions'
import { files } from './files'
import { intake } from './intake'
import { profiles } from './profiles'
import { agent } from './agent'
import { chatTools } from './chatTools'
import { firstRun } from './firstRun'
import { memory } from './memory'
import { platform } from './platform'
import { skills } from './skills'
import { workspace } from './workspace'
import { diagnostics } from './diagnostics'
import { migrations } from './migrations'
import { native } from './native'
import { system } from './system'
import { updates } from './updates'
import { coCard } from './coCard'
import { galleries } from './galleries'
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
import { engines } from '@internal/engines/i18n/en'

/** Every fragment, by area, so the key test can find duplicates across them. */
export const EN_FRAGMENTS = {
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

type Fragments = typeof EN_FRAGMENTS
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never
type Merged = UnionToIntersection<Fragments[keyof Fragments]>

export type MessageKey = keyof Merged & string

export const EN = Object.assign({}, ...Object.values(EN_FRAGMENTS)) as Readonly<Record<MessageKey, string>>
