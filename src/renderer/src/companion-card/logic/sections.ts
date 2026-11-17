/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { COMPANION_SECTIONS } from '@shared/url'
import { t } from '@shared/i18n/core'

// The card's tabs, in the order atelier://companion/<id>/<section> lists them.

export type CardSection = (typeof COMPANION_SECTIONS)[number]

export const SECTION_LABELS: Record<CardSection, string> = {
  get general() { return t('coCard.sections.general') },
  get skills() { return t('coCard.sections.skills') },
  get routines() { return t('coCard.sections.routines') },
  get files() { return t('coCard.sections.files') },
  get memory() { return t('coCard.sections.memory') },
  get models() { return t('coCard.sections.models') },
}

export function isCardSection(value: unknown): value is CardSection {
  return typeof value === 'string' && (COMPANION_SECTIONS as readonly string[]).includes(value)
}

/** The tab a link asks for; unknown or missing sections open General. */
export function normalizeSection(section: string | null | undefined): CardSection {
  return isCardSection(section) ? section : 'general'
}
