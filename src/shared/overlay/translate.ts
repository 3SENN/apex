/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page translation's overlay surface (TR-11): the popover under the pill's translate button.
import type { TabTranslate } from '../translate'

export const TRANSLATE_SURFACES = ['translate-popover'] as const

export type TranslateSurfaceId = (typeof TRANSLATE_SURFACES)[number]

export interface TranslatePopoverProps {
  tabId: string
  /** The tab's TabInfo.translate, kept current while the popover is open. */
  state: TabTranslate
  /** The companion's name, for "Translated by Pip". */
  companion: string
}

export type TranslateSurfaceProps = {
  'translate-popover': TranslatePopoverProps
}
