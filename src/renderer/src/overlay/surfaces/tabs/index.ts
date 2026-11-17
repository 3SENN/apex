/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { GROUP_COLORS } from '@shared/tabs'
import type { TabsSurfaceProps } from '@shared/overlay/tabs'
import { HINT_POLICY, MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { GroupHoverCard } from './GroupHoverCard'
import { RecentTabs } from './RecentTabs'
import { SidebarOptionsSurface } from './SidebarOptionsSurface'
import { SidebarReveal } from './SidebarReveal'
import { SplitMenu } from './SplitMenu'
import { SplitZones } from './SplitZones'
import { TabHoverCard } from './TabHoverCard'
import './tabs.css'

// Tab surfaces (tab and group cards, recent tabs, split, sidebar). Props are
// checked against these schemas when a surface opens.

const text = (max: number) => z.string().max(max)
const dataUrl = z.string().max(400_000).nullable()
const favicon = z.string().max(4096).nullable()
const page = z.object({ tabId: text(64), title: text(400), host: text(300), favicon, thumbnail: dataUrl }).strict()
const placement = { side: z.enum(['right', 'below']), leaving: z.boolean(), glideFrom: z.object({ dx: z.number().finite(), dy: z.number().finite() }).strict().nullable().optional() }

const preview = z
  .object({
    kind: z.enum(['chat', 'routine-run', 'agent-task']),
    lastRequest: z.object({ text: text(2000), source: z.enum(['you', 'routine', 'voice', 'selection']) }).strict().nullable(),
    replySnippet: text(2000).nullable(),
    progress: z.enum(['idle', 'working', 'needs-you', 'done', 'error']),
    pending: z.array(z.object({ kind: z.enum(['approval', 'question', 'handoff']), label: text(300) }).strict()).max(20),
    pendingCount: z.number().int().min(0),
    nextRunAt: z.number().nullable(),
  })
  .strict()

const hoverCard = z.union([
  z.object({ kind: z.literal('tab'), page, live: z.boolean(), ...placement }).strict(),
  z.object({ kind: z.literal('split'), pages: z.array(page).max(2), ...placement }).strict(),
  z.object({ kind: z.literal('chat'), chatId: text(64), title: text(400), preview: preview.nullable(), ...placement }).strict(),
  z.object({ kind: z.literal('routines'), runs: z.array(z.object({ id: text(128), name: text(200), at: z.number() }).strict()).max(8), more: z.number().int().min(0), ...placement }).strict(),
])

const groupCard = z
  .object({
    name: text(80),
    color: z.enum(GROUP_COLORS),
    tabs: z.array(z.object({ tabId: text(64), title: text(400), host: text(300), favicon }).strict()).max(200),
    ...placement,
  })
  .strict()

const recentTabs = z
  .object({
    cards: z.array(z.object({ tabId: text(64), kind: z.enum(['tab', 'split', 'chat']), pages: z.array(page).min(1).max(2) }).strict()).max(8),
    selected: z.number().int().min(0).max(7),
  })
  .strict()

const menuPage = z.object({ tabId: text(64), title: text(400), favicon }).strict()
const splitMenu = z.object({ left: menuPage, right: menuPage, even: z.boolean(), focused: z.enum(['left', 'right']) }).strict()
const splitZones = z.object({ session: z.number().int().nonnegative(), active: z.enum(['left', 'right']).nullable(), block: z.enum(['already-split', 'agent', 'replying']).nullable(), reach: z.number().min(0).max(1) }).strict()
const sidebarOptions = z.object({ options: z.record(z.string(), z.unknown()) }).strict()

/** Split zones: a drop target over the page (interactive), so the page itself never gets the drop. */
const ZONES_POLICY = { ...HINT_POLICY, tier: 'interactive' as const, size: 'fill-tab' as const, onTabSwitch: 'stay' as const }

/** Hover cards: interactive (the Routines card's rows click), never focused, gone in about 100 ms (DS-92). */
const CARD_POLICY = { ...HINT_POLICY, tier: 'interactive' as const, outsideClick: 'close' as const, exitMs: 100 }

const module = <S extends keyof TabsSurfaceProps>(m: SurfaceModule<TabsSurfaceProps[S]>): SurfaceModule<never> => m as unknown as SurfaceModule<never>

export const TABS_SURFACE_MAP: SurfaceMap = {
  'tab-hover-card': module<'tab-hover-card'>({ component: TabHoverCard, props: hoverCard as unknown as z.ZodType<TabsSurfaceProps['tab-hover-card']>, policy: CARD_POLICY, placement: 'below', gap: 0 }),
  'group-hover-card': module<'group-hover-card'>({ component: GroupHoverCard, props: groupCard as unknown as z.ZodType<TabsSurfaceProps['group-hover-card']>, policy: CARD_POLICY, placement: 'below', gap: 0 }),
  'recent-tabs': module<'recent-tabs'>({ component: RecentTabs, props: recentTabs as unknown as z.ZodType<TabsSurfaceProps['recent-tabs']>, policy: { ...MENU_POLICY, layer: 'modal', onTabSwitch: 'stay' }, placement: 'center' }),
  'split-menu': module<'split-menu'>({ component: SplitMenu, props: splitMenu as unknown as z.ZodType<TabsSurfaceProps['split-menu']>, policy: MENU_POLICY, placement: 'below', gap: 4 }),
  'split-zones': module<'split-zones'>({ component: SplitZones, props: splitZones as unknown as z.ZodType<TabsSurfaceProps['split-zones']>, policy: ZONES_POLICY }),
  'sidebar-reveal': module<'sidebar-reveal'>({ component: SidebarReveal, props: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>, policy: { ...MENU_POLICY, size: 'fill-tab', focus: false, layer: 'menu', onTabSwitch: 'stay' } }),
  'sidebar-options': module<'sidebar-options'>({ component: SidebarOptionsSurface, props: sidebarOptions as unknown as z.ZodType<TabsSurfaceProps['sidebar-options']>, policy: MENU_POLICY, placement: 'below', gap: 4 }),
}
