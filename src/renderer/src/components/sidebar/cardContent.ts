/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { TabInfo } from '@shared/ipc'
import type { TabCardPage } from '@shared/overlay/tabs'
import type { Routine } from '@shared/services'
import type { TabGroup } from '@shared/tabs'
import { internalTitle, isBlankUrl, isInternalUrl } from '@shared/url'
import { call } from '../../api'
import { t } from '@shared/i18n/core'
import type { CardContent } from './hoverCard'

// What each hover card shows (SH-28, SH-07), built when the card opens.

/** The host a card shows: the site without www, the Apex page's name, or New Tab. */
export function cardHost(url: string): string {
  if (isBlankUrl(url)) return t('tabs.card.newTab')
  if (isInternalUrl(url)) return t('tabs.sidebarCardContent.apex', { title: internalTitle(url).title })
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

async function page(tab: TabInfo): Promise<TabCardPage> {
  const thumbnail = await call('tabs', 'thumbnail', tab.id).catch(() => null)
  return { tabId: tab.id, title: tab.title || t('tabs.card.newTab'), host: cardHost(tab.url), favicon: tab.favicon, thumbnail }
}

export async function tabCard(tab: TabInfo): Promise<CardContent> {
  return { surface: 'tab-hover-card', props: { kind: 'tab', page: await page(tab), live: tab.audible } }
}

export async function splitCard(left: TabInfo, right: TabInfo): Promise<CardContent> {
  return { surface: 'tab-hover-card', props: { kind: 'split', pages: await Promise.all([page(left), page(right)]) } }
}

/** ChatPreview comes from chats.preview; without it the card still shows the title. */
export async function chatCard(chat: Pick<ChatSummary, 'id' | 'title'>): Promise<CardContent> {
  const preview = await call('chats', 'preview', chat.id).catch(() => null)
  return { surface: 'tab-hover-card', props: { kind: 'chat', chatId: chat.id, title: chat.title, preview } }
}

/** Up to eight upcoming runs, soonest first, plus how many more are scheduled. */
export function upcomingRuns(routines: readonly Pick<Routine, 'id' | 'name' | 'enabled' | 'nextRunAt'>[], limit = 8): { runs: { id: string; name: string; at: number }[]; more: number } {
  const all = routines
    .filter((r) => r.enabled && r.nextRunAt !== null)
    .map((r) => ({ id: r.id, name: r.name, at: r.nextRunAt as number }))
    .sort((a, b) => a.at - b.at)
  return { runs: all.slice(0, limit), more: Math.max(0, all.length - limit) }
}

export function routinesCard(routines: readonly Routine[]): CardContent {
  return { surface: 'tab-hover-card', props: { kind: 'routines', ...upcomingRuns(routines) } }
}

export function groupCard(group: TabGroup, members: readonly TabInfo[]): CardContent {
  return {
    surface: 'group-hover-card',
    props: { name: group.name, color: group.color, tabs: members.map((m) => ({ tabId: m.id, title: m.title || t('tabs.card.newTab'), host: cardHost(m.url), favicon: m.favicon })) },
  }
}
