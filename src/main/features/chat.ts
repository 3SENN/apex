/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatServices, ChatsServiceAdditions } from '@shared/services/chat'
import { stubs } from './stub'
import { createAtWork, type AtWork } from '../atWork'
import { createChatServices, type ChatFeatureServices } from '../agent/chatServices'
import type { Feature, ServiceParts } from './types'

// Chat, the agent at work and the companion.
export const CHATS_ADDITIONS: ChatsServiceAdditions = stubs<ChatsServiceAdditions>([
  'preview',
  'continue',
  'interrupt',
  'sendNow',
  'retryQueued',
  'setActWithoutAsking',
  'setMuted',
  'tabsUsed',
  'closeTabsUsed',
  'older',
  'draft',
  'setDraft',
  'askAbout',
  'quote',
  'retrySave',
])

// OV-20 to OV-22: the agent namespace, quote and askAbout, per-tab watchers
let atWork: AtWork | null = null
// Everything on chats but quote and askAbout
let chatServices: ChatFeatureServices | null = null

export const chatFeature: Feature = {
  name: 'chat',
  app(app): ChatServices & ServiceParts {
    atWork = createAtWork(app)
    chatServices = createChatServices(app)
    return {
      agent: atWork.agent,
      chats: { ...CHATS_ADDITIONS, ...chatServices.chats, ...atWork.chats },
    }
  },
  tab: (tab) => atWork?.tab(tab),
  dispose: () => {
    atWork?.dispose()
    atWork = null
    chatServices?.dispose()
    chatServices = null
  },
}
