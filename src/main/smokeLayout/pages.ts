/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SETUP_STEPS, type SetupStepId } from '@shared/onboarding'
import { INTERNAL_PAGES, SETTINGS_ALIAS_PARENTS, SETTINGS_PAGES } from '@shared/url'

// What the layout audit visits: every apex:// page and every Settings page,
// every step of the setup flow (apex://welcome at that step), the new-tab
// page, and the window sizes it opens them at.

export interface LayoutPage {
  /** File-safe name: settings-you, connectors, newtab... */
  name: string
  /** The apex:// address, or null for the new-tab page (a blank tab). */
  url: string | null
  /** apex://welcome only: the setup step to put setup at before opening it. */
  welcomeStep?: SetupStepId
}

export interface LayoutSize {
  width: number
  height: number
  /** The chat side panel is open beside the page. */
  panel: boolean
}

/** The audit widths (900 to 1920), then 1280 again with the side panel open. */
export const LAYOUT_SIZES: readonly LayoutSize[] = [
  { width: 900, height: 700, panel: false },
  { width: 1280, height: 800, panel: false },
  { width: 1470, height: 923, panel: false },
  { width: 1920, height: 1080, panel: false },
  { width: 1280, height: 800, panel: true },
]

/** A size's report label, from the content size the window actually got (a screen can cap the height). */
export function sizeLabel(width: number, height: number, panel: boolean): string {
  return `${width}x${height}${panel ? '+panel' : ''}`
}

/** Addresses for the pages that need an id or a target; a page whose value is null is left out. */
export interface LayoutTargets {
  chatId: string | null
  companionId: string | null
  /** apex://file?src=... for a file the run added. */
  fileUrl: string | null
  /** apex://view-source?url=... for a fixture page. */
  sourceUrl: string | null
}

/**
 * Every page in INTERNAL_PAGES (Settings expanded into SETTINGS_PAGES, the
 * welcome page into each setup step) plus the new-tab page. `library` has
 * no page of its own (only library/files, which `files` opens).
 */
export function layoutPages(targets: LayoutTargets): LayoutPage[] {
  const pages: LayoutPage[] = [{ name: 'newtab', url: null }]
  for (const page of Object.keys(INTERNAL_PAGES)) {
    if (page === 'library') continue
    if (page === 'settings') {
      for (const s of SETTINGS_PAGES) pages.push({ name: `settings-${s.id}`, url: `apex://settings/${s.id}` })
      // Sub-views with an address of their own (Site settings, Permissions) lay out on their own too.
      for (const sub of Object.keys(SETTINGS_ALIAS_PARENTS)) pages.push({ name: `settings-${sub}`, url: `apex://settings/${sub}` })
      continue
    }
    if (page === 'welcome') {
      for (const step of SETUP_STEPS) pages.push({ name: `welcome-${step}`, url: 'apex://welcome', welcomeStep: step })
      continue
    }
    const url =
      page === 'chat' ? (targets.chatId ? `apex://chat/${targets.chatId}` : null)
      : page === 'companion' ? (targets.companionId ? `apex://companion/${targets.companionId}` : null)
      : page === 'file' ? targets.fileUrl
      : page === 'view-source' ? targets.sourceUrl
      : `apex://${page}`
    if (url) pages.push({ name: page, url })
  }
  return pages
}
