/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createContext, useContext } from 'react'
import type { Companion } from '@shared/companion'

// What deep shell parts (rows, menus, the toolbar) ask App to do, and the
// companions they draw avatars for. App provides both.

export interface ShellActions {
  /** Opens the companion panel, on this chat when given. */
  openPanel(chatId?: string | null): void
  togglePanel(): void
  /** ⇧⌘E: a fresh chat in the panel beside the page. */
  newChatBeside(): void
  openCompanionCard(companionId: string, section?: string | null): void
  /** Asks for a window name (a small dialog). */
  renameWindow(): void
  openFind(): void
  focusAddress(): void
  /** Remounts an apex:// page or the new tab (⌘R, or a destination clicked again). */
  remountPage(tabId: string): void
}

const noop = (): void => undefined

export const ShellContext = createContext<ShellActions>({
  openPanel: noop,
  togglePanel: noop,
  newChatBeside: noop,
  openCompanionCard: noop,
  renameWindow: noop,
  openFind: noop,
  focusAddress: noop,
  remountPage: noop,
})

export function useShell(): ShellActions {
  return useContext(ShellContext)
}

export interface CompanionsInfo {
  list: Companion[]
  activeId: string
}

export const CompanionsContext = createContext<CompanionsInfo>({ list: [], activeId: '' })

export function useCompanions(): CompanionsInfo {
  return useContext(CompanionsContext)
}

/** A companion by id; null for a deleted one (show the neutral avatar). */
export function useCompanionById(id: string | null | undefined): Companion | null {
  const { list } = useCompanions()
  return (id && list.find((c) => c.id === id)) || null
}
