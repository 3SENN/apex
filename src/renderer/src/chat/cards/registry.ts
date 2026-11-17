/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reply cards by log item kind. ChatLog asks here before its own rendering,
// so reply cards (next steps, memory changes, tabs opened, files, connector
// needed) and later ones plug in without editing the log.
import type { ComponentType } from 'react'
import type { LogItem } from '../../agentLog'
import { createKeyedRegistry } from '../logic/cardRegistry'

export type LogKind = LogItem['kind']

export interface LogCardProps<K extends LogKind = LogKind> {
  item: Extract<LogItem, { kind: K }>
  chatId: string
}

const cards = createKeyedRegistry<LogKind, ComponentType<LogCardProps<never>>>()

/** One card per kind; a later registration replaces the earlier one (returns an unregister). */
export function registerLogCard<K extends LogKind>(kind: K, component: ComponentType<LogCardProps<K>>): () => void {
  return cards.register(kind, component as unknown as ComponentType<LogCardProps<never>>)
}

/** The card for a kind, or null when ChatLog renders it itself. */
export function logCardFor<K extends LogKind>(kind: K): ComponentType<LogCardProps<K>> | null {
  return cards.get(kind) as unknown as ComponentType<LogCardProps<K>> | null
}
