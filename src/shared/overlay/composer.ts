/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `composer`: the composer's add-context menu,
// @ mentions, # record search and the long-paste preview. Components and
// policies live in src/renderer/src/overlay/surfaces/composer/index.ts.
export const COMPOSER_SURFACES = ['composer-add-menu', 'mention-list', 'record-search', 'paste-preview'] as const

export type ComposerSurfaceId = (typeof COMPOSER_SURFACES)[number]

/** Every composer surface works on one chat's draft (its id is the draft key). */
export interface ComposerSurfaceProps {
  'composer-add-menu': { chatId: string }
  'mention-list': { chatId: string; query: string }
  'record-search': { chatId: string; query: string }
  'paste-preview': { chatId: string; attachmentId: string }
}
