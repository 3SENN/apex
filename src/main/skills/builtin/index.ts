/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The built-in skills,
// shipped with the app as SKILL.md text, read-only and never deletable
// ("Duplicate to edit" makes your own copy). The brand-kit skill sits beside them.
// Each file's `version` front matter key is its builtinVersion; bump it when
// the text changes.
import { withBrand } from '@shared/branding'
import appDesign from './app-design/SKILL.md?raw'
import { BRAND_KIT_ID, BRAND_KIT_MARKDOWN, BRAND_KIT_VERSION } from './brand-kit'
import compareOptions from './compare-options/SKILL.md?raw'
import documentOutline from './document-outline/SKILL.md?raw'
import meetingPrep from './meeting-prep/SKILL.md?raw'
import pageSummary from './page-summary/SKILL.md?raw'
import priceWatch from './price-watch/SKILL.md?raw'
import readingDigest from './reading-digest/SKILL.md?raw'
import researchBrief from './research-brief/SKILL.md?raw'
import tripPlan from './trip-plan/SKILL.md?raw'
import weeklyReview from './weekly-review/SKILL.md?raw'

export interface BuiltinSource {
  id: string
  /** SKILL.md text. */
  text: string
  /** Overrides the file's `version` key (brand-kit keeps its own constant). */
  version?: string
}

/** Built-in ids are `builtin-<name>`, the scheme brand-kit uses. */
export const builtinId = (name: string): string => `builtin-${name}`

export const BUILTIN_SOURCES: readonly BuiltinSource[] = [
  { id: BRAND_KIT_ID, text: BRAND_KIT_MARKDOWN, version: BRAND_KIT_VERSION },
  // APP-UI: how an app a companion builds should look (build_app points here).
  { id: builtinId('app-design'), text: withBrand(appDesign) },
  { id: builtinId('compare-options'), text: compareOptions },
  { id: builtinId('document-outline'), text: documentOutline },
  { id: builtinId('meeting-prep'), text: meetingPrep },
  { id: builtinId('page-summary'), text: pageSummary },
  { id: builtinId('price-watch'), text: priceWatch },
  { id: builtinId('reading-digest'), text: readingDigest },
  { id: builtinId('research-brief'), text: researchBrief },
  { id: builtinId('trip-plan'), text: tripPlan },
  { id: builtinId('weekly-review'), text: weeklyReview },
]
