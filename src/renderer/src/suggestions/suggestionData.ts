/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Site suggestions in the chrome (OV-23): the live suggestion for a tab, and
// drafting one of its tasks into a chat. The task's text goes into the
// chat's composer draft; nothing is sent until the person sends it.
import { useEffect, useState } from 'react'
import type { SiteSuggestion } from '@shared/siteSuggestions'
import { chatUrl } from '@shared/url'
import { atelier, call } from '../api'
import { setDraftText } from '../chat/surfaces'
import { useEvent } from '../settings/data'

/**
 * Fired (cancelable) on window when a task is drafted into a chat whose
 * composer may already be on screen: { chatId, text }. A mounted composer
 * that inserts the text calls preventDefault(); otherwise the chat opens in
 * a tab with the draft waiting.
 */
export const SUGGESTION_DRAFT_EVENT = 'atelier:suggestion-draft'

export interface SuggestionDraftDetail {
  chatId: string
  text: string
}

/** The suggestion for one tab, kept live by the 'site-suggestion' event; null while there is none. */
export function useSiteSuggestion(tabId: string | null): SiteSuggestion | null {
  const [suggestion, setSuggestion] = useState<SiteSuggestion | null>(null)
  useEffect(() => {
    setSuggestion(null)
    if (!tabId) return
    let live = true
    Promise.resolve(call('siteSuggestions', 'current', tabId))
      .then((s) => {
        if (live) setSuggestion(s)
      })
      .catch(() => {
        // No suggestion is the quiet answer: the card or button just stays away.
      })
    return () => {
      live = false
    }
  }, [tabId])
  useEvent('site-suggestion', (e) => {
    if (e.tabId === tabId) setSuggestion(e.suggestion)
  })
  return suggestion
}

/** Drafts a task into the attached chat (or a new one) and shows it; returns the chat id. Throws main's clear message on failure. */
export async function draftSuggestionTask(tabId: string, task: { id: string; prompt: string }, chatId: string | null): Promise<string> {
  const target = await call('siteSuggestions', 'draft', tabId, task.id, chatId ? { chatId } : 'new')
  setDraftText(target, task.prompt)
  const consumed = !window.dispatchEvent(new CustomEvent<SuggestionDraftDetail>(SUGGESTION_DRAFT_EVENT, { detail: { chatId: target, text: task.prompt }, cancelable: true }))
  if (!consumed) await atelier.tabs.create(chatUrl(target))
  return target
}
