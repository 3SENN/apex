/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat feature module (`chatTools` in FEATURES) and its service schemas:
// export, moving chats into projects, delegated
// children, and ⌘F in a chat (through commands.intercept('find'), so
// App.tsx needs no edit).
import { z } from 'zod'
import type { ChatView } from '@shared/chats'
import { EXPORT_FORMATS, EXPORT_KINDS, chatMessages, chatToMarkdown, chatToText, type ChatToolsServices, type ChatsProjectMethods } from '@shared/exportFormat'
import { UI } from '@shared/ipc'
import { parseInternalUrl } from '@shared/url'
import type { ChatStore } from './chats'
import { chatIdSchema, chatIdsSchema, idSchema } from './serviceKit'
import { createExporter, electronExporterDeps, registerExportSource, type ExporterDeps } from './exporter'
import { htmlDocument } from './exportTemplates/html'
import type { AppContext, Feature, WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import type { AdditionSchemas, SchemaMap } from './schemas/types'

const exportKind = z.enum(EXPORT_KINDS)

/** Methods this module adds to `chats`. */
export const CHATS_PROJECT_SCHEMAS: AdditionSchemas<ChatsProjectMethods> = {
  setProject: z.tuple([chatIdsSchema, idSchema.nullable()]),
  children: z.tuple([chatIdSchema]),
}

export const CHAT_TOOLS_SCHEMAS: SchemaMap<ChatToolsServices> = {
  exporter: {
    formats: z.tuple([exportKind]),
    copyText: z.tuple([exportKind, idSchema]),
    save: z.tuple([exportKind, z.array(idSchema).min(1).max(1000), z.enum(EXPORT_FORMATS)]),
    print: z.tuple([exportKind, idSchema]),
    mailDraft: z.tuple([exportKind, idSchema]),
    reveal: z.tuple([z.string().min(1).max(4096)]),
  },
}

const idList = (ids: string | string[]): string[] => (Array.isArray(ids) ? ids : [ids])

/** Moving chats into a project, and a parent's delegated children. */
export function chatsProjectMethods(chats: Pick<ChatStore, 'update' | 'list'>): ChatsProjectMethods {
  return {
    setProject(ids, projectId) {
      chats.update(idList(ids), { projectId })
    },
    children(parentId) {
      // Oldest first: the order the parent handed the work out.
      return chats.list().filter((c) => c.parentChatId === parentId).sort((a, b) => a.createdAt - b.createdAt)
    },
  }
}

/** What the chat export source reads; the host in the app, a fake in tests. */
export interface ChatExportHost {
  view(id: string): Pick<ChatView, 'summary' | 'log' | 'details'>
  companionName(companionId: string): string | null
}

/** CH-36: chats as text, Markdown (the format chat import reads back) and HTML. */
export function registerChatExportSource(host: ChatExportHost): void {
  const load = (id: string): { view: Pick<ChatView, 'summary' | 'log' | 'details'>; companionName: string } => {
    const view = host.view(id)
    if (view.summary.draft) throw new Error(mainT('chatTools.export.error.draft'))
    return { view, companionName: host.companionName(view.summary.companionId) ?? mainT('chatTools.export.companionFallback') }
  }
  registerExportSource('chat', {
    title: (id) => host.view(id).summary.title,
    markdown: (id) => {
      const { view, companionName } = load(id)
      return chatToMarkdown(view, { companionName })
    },
    text: (id) => {
      const { view, companionName } = load(id)
      return chatToText(view, { companionName })
    },
    html: (id) => {
      const { view, companionName } = load(id)
      return htmlDocument({
        title: view.summary.title,
        meta: `${companionName} · ${new Date(view.summary.createdAt).toLocaleString()}`,
        sections: chatMessages(view).map((m) => ({
          heading: m.role === 'user' ? mainT('chatTools.export.you') : companionName,
          at: m.at,
          markdown: m.text,
          tone: m.role === 'user' ? ('you' as const) : ('companion' as const),
        })),
      })
    },
  })
}

/** ⌘F on a chat page finds in the chat; on a website it still finds in the page. */
export function isChatFindTarget(win: Pick<WindowContext, 'tabs'> | null): boolean {
  const url = win?.tabs.active()?.internalUrl
  return !!url && parseInternalUrl(url)?.page === 'chat'
}

// NS-03: lives beside the presenter's other rules, which call it for every notification.
export { chatNotificationSilent } from './notifications'

export function createChatFeatures(options: { exporterDeps?: () => ExporterDeps } = {}): Feature {
  const offs: Array<() => void> = []
  return {
    name: 'chatTools',
    app(ctx: AppContext) {
      registerChatExportSource({ view: (id) => ctx.agent.view(id), companionName: (id) => ctx.agent.companionName(id) })
      offs.push(
        ctx.commands.intercept('find', {
          when: isChatFindTarget,
          run: (win) => {
            if (win && !win.chrome.isDestroyed()) win.chrome.send(UI.command, 'find-in-chat')
          },
        }),
      )
      const exporter = createExporter(options.exporterDeps?.() ?? electronExporterDeps(() => ctx.windows.focused()?.window ?? null))
      return {
        chats: chatsProjectMethods(ctx.maintenance.chats),
        exporter,
      }
    },
    dispose() {
      for (const off of offs.splice(0)) off()
    },
  }
}
