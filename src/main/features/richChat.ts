/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DIRECTORY } from '../connectors/directory'
import { deleteRemoteFiles, RemoteFileCache } from '../agent/content'
import { PdfTabReader } from '../agent/pdfTab'
import type { RichChatDeps } from '../agent/sessionRichChat'
import { log } from '../log'
import { builtinSkill } from '../skills/builtin/brand-kit'
import type { AppContext, Feature } from './types'

// The rich-chat feature module: content blocks, compaction, documents, client
// tools and the reply events, on every engine. It hands every chat session
// the other features' main-side APIs (read when used, so a feature that
// starts later is picked up), and adds the chat methods it needs: compact,
// continueInNewChat, editAndResend with attachments, and duplicate with
// copies of them.

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase()

export function createRichChatDeps(ctx: Pick<AppContext, 'content' | 'dataDir' | 'agent'>): RichChatDeps {
  return {
    attachments: () => ctx.content.attachments,
    chatContext: () => ctx.content.chatContext,
    libraryFiles: () => ctx.content.libraryFiles,
    connectors: () => ctx.content.connectors,
    remoteFiles: new RemoteFileCache(ctx.dataDir),
    pdf: new PdfTabReader(),
    directory: () => {
      // A directory service counts as connected when a connector that is on uses its endpoint.
      const urls = ctx.agent.connectedUrls()
      const entries = DIRECTORY.slice()
      return { entries, connected: entries.filter((e) => urls.some((url) => sameUrl(url, e.url))).map((e) => e.id) }
    },
    builtinSkill,
  }
}

export function createRichChatFeature(): Feature {
  let unsubscribe: (() => void) | null = null
  return {
    name: 'richChat',
    app(ctx) {
      const deps = createRichChatDeps(ctx)
      ctx.agent.useRichChat(deps)

      // Uploads go when no chat refers to them any more (best effort, under the current key).
      const onRemoved = (ids: string[]): void => {
        ctx.agent.chatsRemoved(ids) // what other engines kept for them goes too
        for (const id of ids) {
          let extra: string[] = []
          try {
            extra = ctx.content.attachments.remoteFiles(id)
          } catch {
            extra = []
          }
          const gone = deps.remoteFiles.removeChat(id, extra)
          if (gone.length === 0) continue
          void deleteRemoteFiles(ctx.agent.filesApi(), gone).then((n) => {
            if (n > 0) log.debug('agent', 'Deleted remote files of a removed chat', { count: n })
          })
        }
      }
      try {
        ctx.maintenance.chats.on('removed', onRemoved)
        unsubscribe = () => ctx.maintenance.chats.off('removed', onRemoved)
      } catch {
        // ctx.maintenance's chat store isn't wired (tests): remote files stay until the key's files are cleared.
      }

      return {
        chats: {
          compact: (id) => ctx.agent.compact(id),
          continueInNewChat: (id, options) => ctx.agent.continueInNewChat(id, options),
          editAndResend: (id, userMessageId, text, attachments) => ctx.agent.editAndResend(id, userMessageId, text, attachments),
          duplicate: (id) => {
            const { summary, failed } = ctx.agent.duplicate(id)
            ctx.broadcast({ type: 'chat-duplicated', chatId: summary.id, sourceId: id, failedAttachments: failed })
            return summary
          },
        },
      }
    },
    dispose() {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}
