/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary, ChatView } from '@shared/chats'
import type { Effort } from '@shared/ipc'
import type { ChatMigrationError } from './runner'

// The view of a chat whose file is damaged or was saved by a newer Atelier
// (SS-09). AgentHost.view() returns it instead of loading a session, so
// nothing can write to the file: the composer is disabled by the notice, and
// every other host call refuses because the session never loads. A newer
// file still shows what this build can read of it, read-only.

export interface NoticeViewInput {
  summary: ChatSummary
  error: ChatMigrationError
  /** The host's event sequence, so live events after this view still apply. */
  seq: number
  /** The global effort, shown when the file doesn't say. */
  effort: Effort
}

export function noticeView({ summary, error, seq, effort }: NoticeViewInput): ChatView {
  const content = error.readOnly
  const caps = content?.capabilities
  return {
    summary,
    setup: {
      companionId: summary.companionId,
      model: caps?.model ?? summary.model,
      effort: caps?.effort ?? effort,
      browser: caps?.browser ?? false,
      webTools: caps?.webTools ?? false,
      memory: caps?.memory ?? false,
      connectorIds: [...(caps?.connectorIds ?? [])],
      engine: caps?.engine ?? 'api-key',
      fixed: true,
      clientTools: [...(caps?.clientTools ?? [])],
      private: caps?.private ?? summary.private,
      documents: caps?.documents ?? false,
      compaction: caps?.compaction ?? false,
    },
    log: content ? content.log.slice() : [],
    seq,
    agentStatus: 'idle',
    details: content ? { ...content.details } : {},
    feedback: content ? { ...content.feedback } : {},
    queued: [],
    tabIds: [],
    usedTabIds: [],
    notice: {
      kind: error.kind === 'newer' ? 'newer-format' : 'migration-failed',
      message: error.message,
      backup: error.backup,
    },
  }
}
