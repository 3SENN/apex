/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@internal/engines/cards` in a build from public code: no engines besides
// the API key, so no error codes of their own (src/shared/chatErrors.ts). A
// build with the private internal/ folder takes internal/engines/cards.ts.
import type { ChatErrorFacts } from '@shared/chatErrors'
import type { ErrorCardBody, ErrorCardSpec } from '../../renderer/src/chat/logic/errors'

/** The cards of the engines' own error codes. */
export const EXTRA_ERROR_CARDS: Readonly<Record<string, ErrorCardSpec>> = {}

/** A card's line for an engine's code from its facts (versions, model); null keeps the card's own. */
export function extraErrorBody(_code: string, _facts: ChatErrorFacts | undefined, _model: string | null): ErrorCardBody | null {
  return null
}
