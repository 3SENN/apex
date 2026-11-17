/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Request cards for the tray docked above the composer (CH-38).
// Approvals, questions and hand-offs are built-in kinds; connector approvals
// and other requests are registered here, so the tray never needs an edit.
import type { ComponentType } from 'react'

/** One pending request as the tray holds it. `data` is the kind's own payload. */
export interface PendingRequest {
  id: string
  kind: string
  chatId: string
  data: unknown
}

export interface RequestCardProps {
  request: PendingRequest
  chatId: string
  /** Answers the request; the tray moves on to the next one. */
  done(answer?: unknown): void
  /** Hides the request without answering (Dismiss). */
  dismiss(): void
}

const cards = new Map<string, ComponentType<RequestCardProps>>()

/** One card per kind; a later registration replaces the earlier one. Returns the removal. */
export function registerRequestCard(kind: string, Component: ComponentType<RequestCardProps>): () => void {
  cards.set(kind, Component)
  return () => {
    if (cards.get(kind) === Component) cards.delete(kind)
  }
}

/** The card for a kind, or null when the tray draws it itself. */
export function requestCardFor(kind: string): ComponentType<RequestCardProps> | null {
  return cards.get(kind) ?? null
}

// Other requests come from the log; the tray lists them through pendingRequests
type LogItems = readonly import('../agentLog').LogItem[]
type RequestSource = (items: LogItems, chatId: string) => PendingRequest[]

const requestSources = new Set<RequestSource>()

/** Adds a source of pending requests read from a chat's log. Returns the removal. */
export function registerRequestSource(source: RequestSource): () => void {
  requestSources.add(source)
  return () => void requestSources.delete(source)
}

/** Every registered source's pending requests for a chat, oldest first within each source. */
export function pendingRequests(items: LogItems, chatId: string): PendingRequest[] {
  return [...requestSources].flatMap((source) => source(items, chatId))
}
