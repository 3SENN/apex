/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'

/**
 * DS-72b: the Chats section lists saved chats only. An empty chat open as a
 * page is not in the list until its first send (it shows under Your tabs
 * meanwhile), and a draft record never gets a row of its own.
 */
export function chatListRows(orderedIds: readonly string[], byId: ReadonlyMap<string, ChatSummary>): ChatSummary[] {
  return orderedIds.map((id) => byId.get(id)).filter((c): c is ChatSummary => c !== undefined && !c.draft)
}
