/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Help topics. Asking about one starts
// a chat whose first message carries Atelier's own help notes for that topic.

import { BRAND_NAME } from './branding'
export const HELP_TOPIC_IDS = ['getting-started', 'chats-companions', 'skills-routines', 'meetings', 'connectors', 'troubleshooting'] as const
export type HelpTopicId = (typeof HELP_TOPIC_IDS)[number]

export interface HelpTopic {
  id: HelpTopicId
  title: string
}

export interface HelpService {
  topics(): HelpTopic[]
  /** Starts a help chat; returns its id. */
  ask(topicId: HelpTopicId): string
}

/** The Help menu's groups (ON-17), in menu order. */
export const HELP_TOPICS: readonly HelpTopic[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'chats-companions', title: 'Chats and companions' },
  { id: 'skills-routines', title: 'Skills and routines' },
  { id: 'meetings', title: 'Meetings' },
  { id: 'connectors', title: 'Connectors' },
  { id: 'troubleshooting', title: 'Troubleshooting' },
]

/** The first message of a help chat. */
export function helpQuestion(topic: HelpTopic): string {
  return `I have a question about ${topic.title.toLowerCase()} in ${BRAND_NAME}. What should I know first?`
}
