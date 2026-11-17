/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ATTACHMENT_LIMITS, type AttachmentRef, type AttachmentsEvent, type AttachmentsServices } from '@shared/attachments'
import type { ChatContextEvent, ChatContextServices } from '@shared/chatContext'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import { mainT } from '../i18n/mainT'
import type { PdfReader } from '../pdf/client'
import { chatFilesReader } from './chatFiles'
import { ContextRegistry } from './context'
import { pdfPageLimit, type ImageProcessor } from './prepare'
import { Attachments, type SourceDeps } from './store'
import type { AttachmentStore, ChatContextRegistry, ChatFilesReader } from './types'

// The intake: the attachment pipeline, the pages-in-chat registry and the
// chat's virtual files. Everything Electron-specific (tabs, the page bridge,
// the hidden renderer, the pdf worker, dialogs) arrives through `host`, which
// features/intake.ts builds; without it the intake still works on what it can
// (pastes, selections and text files), which is what the unit tests use.

/** The app around the intake. Each piece is optional so tests pass only what they exercise. */
export interface IntakeHost {
  sources?: Partial<SourceDeps>
  images?: ImageProcessor
  pdf?: PdfReader
  heic?(path: string): Uint8Array | null
  /** Settings › Model and key's Files and documents switch, for this chat. */
  documentsOn?(chatId: string): boolean
  /** The model this chat runs on (the PDF page cap depends on it). */
  model?(chatId: string): string
  /** The saved chat, for its files. */
  chat?(chatId: string): { messages: readonly unknown[]; log: readonly AgentEvent[]; updatedAt: number } | null
  /** The Library files this chat produced. */
  generated?(chatId: string): LibraryFileRef[]
  controlledTabs?(chatId: string): readonly string[]
  focusTab?(tabId: string): void
  closeTab?(tabId: string): void
  /** The system open dialog; resolves to the picked paths (empty when cancelled). */
  pickFiles?(): Promise<string[]>
  reveal?(path: string): void
  platform?: NodeJS.Platform
  now?: () => number
}

export interface IntakeDeps {
  dataDir: string
  broadcast(event: AttachmentsEvent | ChatContextEvent): void
  host?: IntakeHost
}

export interface Intake {
  services: AttachmentsServices & ChatContextServices
  store: AttachmentStore
  context: ChatContextRegistry
  /** Main-side reads of the chat's virtual files (the file viewer). */
  chatFiles: ChatFilesReader
  /** A tab closed; its pages stay listed without it. */
  tabClosed(tabId: string): void
  /** Chats were deleted: their attachments and pages go too (after this tick, so remote cleanup can read them first). */
  chatsRemoved(ids: readonly string[]): void
  /** The meetings changed: attached meetings check their transcript again (MV-14). */
  meetingsChanged(): void
  /** Drops the folders of drafts that never became chats. */
  sweep(isChat: (chatId: string) => boolean): void
  dispose(): void
}

const unavailable = (): never => {
  throw new Error(mainT('intake.reason.prepareFailed'))
}

/** The largest file a picker may hand in; bigger ones are refused without reading them. */
const PICK_MAX = Math.max(ATTACHMENT_LIMITS.pdfBytes, ATTACHMENT_LIMITS.imageInputBytes, ATTACHMENT_LIMITS.officeBytes)

export function setupIntake(deps: IntakeDeps): Intake {
  const host = deps.host ?? {}
  const sources: SourceDeps = {
    tab: () => null,
    readTab: async () => unavailable(),
    fetchFromTab: async () => unavailable(),
    chatTitle: () => null,
    chatMarkdown: () => null,
    skill: () => null,
    meeting: async () => null,
    record: async () => unavailable(),
    ...host.sources,
  }
  const context = new ContextRegistry({
    dir: join(deps.dataDir, 'chats'),
    emit: (chatId, pages) => deps.broadcast({ type: 'chat-context', chatId, pages }),
    controlledTabs: (chatId) => host.controlledTabs?.(chatId) ?? [],
    tabInfo: (tabId) => sources.tab(tabId),
    focusTab: (tabId) => host.focusTab?.(tabId),
    closeTab: (tabId) => host.closeTab?.(tabId),
    now: host.now,
  })
  const store = new Attachments({
    dir: join(deps.dataDir, 'attachments'),
    prepare: {
      images: host.images ?? { prepareImage: async () => unavailable(), rasterizeSvg: async () => unavailable(), pdfThumbnail: async () => null, dispose: () => {} },
      pdf: host.pdf ?? { read: async () => ({ ok: false, error: 'broken' }) },
      heic: (path) => host.heic?.(path) ?? null,
      documentsOn: (chatId) => host.documentsOn?.(chatId) ?? false,
      pdfMaxPages: (chatId) => pdfPageLimit(host.model?.(chatId) ?? ''),
      platform: host.platform ?? process.platform,
    },
    sources,
    emit: (draftKey, items) => deps.broadcast({ type: 'attachments', draftKey, items }),
    // An attached tab is one of the chat's pages (CH-34).
    onTab: (chatId, tab, attached) => (attached ? context.record(chatId, { ...tab, source: 'attached' }) : context.detach(chatId, tab.tabId)),
    now: host.now,
  })
  const files = chatFilesReader(
    {
      load: (chatId) => host.chat?.(chatId) ?? null,
      attachments: (chatId) => store.all(chatId),
      attachmentText: (chatId, id) => store.text(chatId, id),
      generated: (chatId) => host.generated?.(chatId) ?? [],
    },
    (path) => host.reveal?.(path),
  )

  /** Reads picked files; one too big to read becomes a failed chip with its reason. */
  const pick = async (draftKey: string): Promise<AttachmentRef[]> => {
    const paths = (await host.pickFiles?.()) ?? []
    const refs: AttachmentRef[] = []
    for (const path of paths.slice(0, ATTACHMENT_LIMITS.perMessage)) {
      const name = basename(path)
      try {
        const info = await stat(path)
        if (info.size > PICK_MAX) {
          refs.push(store.addPicked(draftKey, name, await readHead(path), info.size))
          continue
        }
        refs.push(store.addPicked(draftKey, name, await readFile(path)))
      } catch (err) {
        // The 21st and later files hit the message cap; say so once.
        if (err instanceof Error && err.message === mainT('intake.error.tooMany', { count: ATTACHMENT_LIMITS.perMessage })) throw err
      }
    }
    return refs
  }

  return {
    services: {
      attachments: {
        add: (draftKey, source) => store.add(draftKey, source),
        pick,
        retry: (draftKey, id) => store.retry(draftKey, id),
        remove: (draftKey, id) => store.remove(draftKey, id),
        list: (draftKey) => store.list(draftKey),
        updateText: (draftKey, id, text) => store.updateText(draftKey, id, text),
        readText: (draftKey, id) => store.readText(draftKey, id),
      },
      chatContext: {
        list: (chatId) => context.list(chatId),
        remove: (chatId, tabId) => context.remove(chatId, tabId),
        focus: (chatId, tabId) => context.focus(chatId, tabId),
        close: (chatId, tabId) => context.close(chatId, tabId),
      },
      chatFiles: {
        list: (chatId, folder) => files.list(chatId, folder),
        read: (chatId, path) => files.read(chatId, path),
        reveal: (chatId, path) => files.reveal(chatId, path),
        count: (chatId) => files.count(chatId),
      },
    },
    store: {
      resolve: (chatId, ids) => store.resolve(chatId, ids),
      bindToMessage: (chatId, ids, messageId) => store.bindToMessage(chatId, ids, messageId),
      copyForChat: (from, to, ids) => {
        const result = store.copyForChat(from, to, ids)
        if (!ids) context.copyChat(from, to)
        return result
      },
      removeChat: (chatId) => {
        store.removeChat(chatId)
        context.removeChat(chatId)
      },
      setRemoteFile: (chatId, id, fingerprint, fileId) => store.setRemoteFile(chatId, id, fingerprint, fileId),
      remoteFiles: (chatId) => store.remoteFiles(chatId),
      sizes: () => store.sizes(),
      pruneImages: (days, chatIds) => store.pruneImages(days, chatIds),
      chatSize: (chatId) => store.chatSize(chatId),
      add: (chatId, source) => store.add(chatId, source),
      settled: (chatId, ids) => store.settled(chatId, ids),
      remoteFile: (chatId, id, fingerprint) => store.remoteFile(chatId, id, fingerprint),
      file: (chatId, id) => store.file(chatId, id),
    },
    context,
    chatFiles: files,
    tabClosed: (tabId) => context.tabClosed(tabId),
    chatsRemoved: (ids) => {
      setTimeout(() => {
        for (const id of ids) {
          store.removeChat(id)
          context.removeChat(id)
        }
      }, 0)
    },
    meetingsChanged: () => store.meetingsChanged(),
    sweep: (isChat) => store.sweep(isChat),
    dispose: () => {
      store.dispose()
      host.images?.dispose()
    },
  }
}

/** The first 64 KB of a file, enough to say what it is. */
async function readHead(path: string): Promise<Uint8Array> {
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}
