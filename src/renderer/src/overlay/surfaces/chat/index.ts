/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { AgentNoticeProps, AgentPillProps, AgentShieldProps, SelectionChipProps } from '@shared/overlay/chat'
import { NOTICE_GAP } from '@shared/agentControl'
import type { SurfaceMap, SurfaceModule } from '../../types'
import { AgentNotice } from './AgentNotice'
import { AgentPill } from './AgentPill'
import { AgentShield } from './AgentShield'
import { SelectionChip } from './SelectionChip'

// The chat overlay surfaces: agent notice, shield, pill and selection chip.

const hex = z.string().regex(/^#[0-9a-f]{6}$/i)
const tabId = z.string().min(1).max(64)
const chatId = z.string().min(1).max(64)
const state = z.enum(['driving', 'paused', 'taken-over', 'challenge', 'resuming', 'idle'])
const companion = z.object({ id: z.string().max(128), name: z.string().max(80), accent: hex, glow: hex }).strict()
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict()

const noticeProps: z.ZodType<AgentNoticeProps> = z
  .object({
    tabId,
    chatId,
    state,
    activity: z.string().max(200).nullable(),
    companion,
    position: point.nullable(),
    solvedAt: z.number().nullable(),
    nudge: z.number().int().min(0),
    beside: z.boolean(),
  })
  .strict()

const shieldProps: z.ZodType<AgentShieldProps> = z.object({ tabId, state, companion, cursor: point.nullable() }).strict()

const pillProps: z.ZodType<AgentPillProps> = z
  .object({ chatId, mode: z.enum(['working', 'approval']), companion, label: z.string().max(200), others: z.number().int().min(0).max(999) })
  .strict()

const chipProps: z.ZodType<SelectionChipProps> = z
  .object({
    tabId,
    text: z.string().max(5000),
    url: z.string().max(8192),
    links: z.array(z.string().max(8192)).max(20),
    companionName: z.string().max(80),
    shortcut: z.string().max(24),
  })
  .strict()

const notice: SurfaceModule<AgentNoticeProps> = {
  component: AgentNotice,
  props: noticeProps,
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'menu', focus: false, exitMs: 180 },
  placement: 'top-center',
  gap: NOTICE_GAP,
}

const shield: SurfaceModule<AgentShieldProps> = {
  component: AgentShield,
  props: shieldProps,
  // It covers the tab and catches presses, but never takes focus or hides the page.
  policy: { tier: 'interactive', size: 'fill-tab', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'hint', focus: false, exitMs: 180 },
}

const pill: SurfaceModule<AgentPillProps> = {
  component: AgentPill,
  props: pillProps,
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'stay', layer: 'hint', focus: false, exitMs: 120 },
  placement: 'below',
  gap: 6,
}

const chip: SurfaceModule<SelectionChipProps> = {
  component: SelectionChip,
  props: chipProps,
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'close', blocksPage: false, onTabSwitch: 'close', onScroll: 'close', layer: 'menu', focus: false, exitMs: 0 },
  placement: 'above',
  gap: 8,
}

export const CHAT_SURFACE_MAP: SurfaceMap = {
  'agent-notice': notice as unknown as SurfaceModule<never>,
  'agent-shield': shield as unknown as SurfaceModule<never>,
  'agent-pill': pill as unknown as SurfaceModule<never>,
  'selection-chip': chip as unknown as SurfaceModule<never>,
}
