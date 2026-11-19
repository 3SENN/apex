/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// `@engines/cards`: the chat error cards of Claude Code's own codes
// (SS-03). Pure.
import type { ChatErrorFacts } from '@shared/chatErrors'
import type { ErrorCardBody, ErrorCardSpec } from '../../src/renderer/src/chat/logic/errors'

export const EXTRA_ERROR_CARDS: Readonly<Record<string, ErrorCardSpec>> = {
  'cc-signed-out': { icon: 'signed-out', tone: 'warning', title: 'engines.chat.error.ccSignedOut.title', body: 'engines.chat.error.ccSignedOut.body', action: 'engine', secondary: 'retry', autoRetry: false },
  'cc-limit': { icon: 'limit', tone: 'warning', title: 'engines.chat.error.ccLimit.title', body: null, action: 'retry', secondary: null, autoRetry: false },
  'cc-missing': { icon: 'missing', tone: 'error', title: 'engines.chat.error.ccMissing.title', body: null, action: 'engine', secondary: null, autoRetry: false },
  // Update Claude Code in the background, then send again (the renderer seam's error step).
  'cc-too-old': { icon: 'update', tone: 'warning', title: 'engines.chat.error.ccTooOld.title', body: null, action: 'engine-step', secondary: 'pick-model', autoRetry: false },
  'cc-model': { icon: 'model', tone: 'error', title: 'engines.chat.error.ccModel.title', body: null, action: 'pick-model', secondary: 'retry', autoRetry: false },
}

export function extraErrorBody(code: string, facts: ChatErrorFacts | undefined, model: string | null): ErrorCardBody | null {
  if (code === 'cc-too-old' && facts?.version) {
    // "Your Claude Code (2.1.50) is too old for Opus 5.5. It needs 2.1.280 or newer."
    if (facts.policy) return { body: 'engines.chat.error.ccTooOld.bodyPolicy', bodyVars: { version: facts.version } }
    if (model && facts.required) return { body: 'engines.chat.error.ccTooOld.body', bodyVars: { version: facts.version, model, required: facts.required } }
    if (model) return { body: 'engines.chat.error.ccTooOld.bodyNoRequired', bodyVars: { version: facts.version, model } }
  }
  if (code === 'cc-model' && model) return { body: 'engines.chat.error.ccModel.body', bodyVars: { model } }
  return null
}
