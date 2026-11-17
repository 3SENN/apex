/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Help topics (ON-17): the Help menu groups six topics; choosing one starts
// a chat about it, grounded in Atelier's own help notes (shipped here as
// Markdown, bundled as text) inside a <help_notes> context block.
import { withBrand } from '@shared/branding'
import { HELP_TOPICS, HELP_TOPIC_IDS, helpQuestion, type HelpService, type HelpTopic, type HelpTopicId } from '@shared/help'
import { t } from '@shared/i18n/core'
import { registerMenuContribution, type MenuItemModel } from '@shared/menuModel'
import type { AgentHostApi } from '../agent/hostApi'
import chatsCompanions from './chats-companions.md?raw'
import connectors from './connectors.md?raw'
import gettingStarted from './getting-started.md?raw'
import meetings from './meetings.md?raw'
import skillsRoutines from './skills-routines.md?raw'
import troubleshooting from './troubleshooting.md?raw'

// The notes say {brand} for the app's name (src/shared/branding.ts).
export const HELP_NOTES: Record<HelpTopicId, string> = {
  'getting-started': withBrand(gettingStarted),
  'chats-companions': withBrand(chatsCompanions),
  'skills-routines': withBrand(skillsRoutines),
  meetings: withBrand(meetings),
  connectors: withBrand(connectors),
  troubleshooting: withBrand(troubleshooting),
}

export function helpContext(topic: HelpTopic): string {
  return `<help_notes topic="${topic.id}">\nAtelier's own help notes about ${topic.title.toLowerCase()}. Answer from them; say so when they don't cover a question.\n\n${HELP_NOTES[topic.id].trim()}\n</help_notes>`
}

export function createHelpService(deps: { host: Pick<AgentHostApi, 'startChat'>; activeCompanionId(): string }): HelpService {
  return {
    topics: () => HELP_TOPICS.map((t) => ({ ...t })),
    ask(topicId) {
      const topic = HELP_TOPICS.find((t) => t.id === topicId)
      if (!topic) throw new Error('That help topic doesn’t exist.')
      const companionId = deps.activeCompanionId()
      return deps.host.startChat(helpQuestion(topic), { ...(companionId ? { companionId } : {}), context: helpContext(topic), open: 'page' })
    },
  }
}

const ITEM_PREFIX = 'help-topic:'

/** The topics as menu items (a header, then one row per topic). */
export function helpMenuItems(): MenuItemModel[] {
  return [
    { id: 'help-topics-separator', label: '', type: 'separator' },
    { id: 'help-topics-header', label: t('firstRun.help.askAbout'), variant: 'header', enabled: false },
    ...HELP_TOPICS.map((t) => ({ id: `${ITEM_PREFIX}${t.id}`, label: t.title })),
  ]
}

/** The topic a menu item asks about, or null. */
export function helpTopicFromItem(itemId: string): HelpTopicId | null {
  if (!itemId.startsWith(ITEM_PREFIX)) return null
  const id = itemId.slice(ITEM_PREFIX.length)
  return (HELP_TOPIC_IDS as readonly string[]).includes(id) ? (id as HelpTopicId) : null
}

/** Registers the topics in the app's Help menu and the main menu's Help submenu. */
export function registerHelpMenus(ask: (topic: HelpTopicId) => void): () => void {
  const run = (itemId: string): void => {
    const topic = helpTopicFromItem(itemId)
    if (topic) ask(topic)
  }
  const offs = [
    registerMenuContribution({ id: 'd-help-topics', target: 'help', build: helpMenuItems, run }),
    registerMenuContribution({ id: 'd-help-topics-main', target: 'main-menu:help', build: helpMenuItems, run }),
  ]
  return () => offs.forEach((off) => off())
}
