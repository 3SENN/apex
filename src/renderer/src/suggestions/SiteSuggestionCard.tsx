/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The site suggestion card (OV-23), mounted in the panel:
// on a site with a matching connector or desktop app, connect it or draft
// one of Atelier's ready-made tasks into this chat. Opt-in and off by default;
// it renders nothing until main offers a suggestion, and it follows the
// page and the chat (the suggestion event and the chatId prop).
import type { ReactElement } from 'react'
import { SuggestionBody } from './SuggestionBody'
import { useSiteSuggestion } from './suggestionData'

export interface SiteSuggestionCardProps {
  tabId: string
  chatId: string | null
}

export function SiteSuggestionCard({ tabId, chatId }: SiteSuggestionCardProps): ReactElement | null {
  const suggestion = useSiteSuggestion(tabId)
  if (!suggestion) return null
  return <SuggestionBody key={`${suggestion.origin}:${chatId ?? 'new'}`} suggestion={suggestion} chatId={chatId} variant="card" />
}
