/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat overlay surfaces: the agent at work and the selection chip.
// `tabs-used` is gone: CH-33 lives in the details panel.
import type { AgentControlState } from '../services/chat'
import type { NoticePosition } from '../agentControl'

export const CHAT_SURFACES = ['agent-notice', 'agent-shield', 'agent-pill', 'selection-chip'] as const

export type ChatSurfaceId = (typeof CHAT_SURFACES)[number]

/** The companion as the surfaces draw it: its name and its accent (already contrast-adjusted for the mode). */
export interface AtWorkCompanion {
  id: string
  name: string
  /** '#rrggbb' for text and rings on the current mode. */
  accent: string
  /** The raw accent, for the glow. */
  glow: string
}

export interface AgentNoticeProps {
  tabId: string
  chatId: string
  state: AgentControlState
  activity: string | null
  companion: AtWorkCompanion
  position: NoticePosition | null
  solvedAt: number | null
  nudge: number
  /** The chat is open beside the page right now (the side-by-side toggle's state). */
  beside: boolean
}

export interface AgentShieldProps {
  tabId: string
  state: AgentControlState
  companion: AtWorkCompanion
  /** The agent's pointer in tab CSS px, or null before its first move. */
  cursor: { x: number; y: number } | null
}

export interface AgentPillProps {
  chatId: string
  mode: 'working' | 'approval'
  companion: AtWorkCompanion
  /** Plain words for what it is doing (or what it asks). */
  label: string
  others: number
}

export interface SelectionChipProps {
  tabId: string
  text: string
  url: string
  links: string[]
  companionName: string
  /** The hint under the actions, e.g. ⌘J. */
  shortcut: string
}

export type SelectionChipAction = 'ask' | 'explain' | 'copy' | 'search'

export type ChatSurfaceProps = {
  'agent-notice': AgentNoticeProps
  'agent-shield': AgentShieldProps
  'agent-pill': AgentPillProps
  'selection-chip': SelectionChipProps
}
