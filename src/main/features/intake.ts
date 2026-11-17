/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { BrowserWindow, dialog, nativeImage, shell } from 'electron'
import { devRendererUrl } from '../appProtocol'
import { mainT } from '../i18n/mainT'
import { engineHasOwnAccount } from '@shared/engine'
import { preprocessAllow, createPreprocessor } from '../intake/preprocess'
import { setupIntake, type IntakeHost } from '../intake/service'
import { IntakeError } from '../intake/prepare'
import { log } from '../log'
import { workerPdfReader } from '../pdf/client'
import { readJson } from '../stores'
import { registerStorageCategory } from '../storage'
import type { Tab } from '../tabs'
import { PREPROCESS_PARTITION, sandboxSession } from './sandboxSessions'
import type { AppContext, Feature } from './types'

// The intake feature module: the attachment pipeline, the pages-in-chat registry
// and the chat files data. It fills ctx.content.attachments, ctx.content.chatContext and
// ctx.content.chatFiles, and adapts the app (tabs, the page bridge, chats, skills,
// meetings, connector records, the files library) to the intake.

/** A web page Apex can read; apex:// pages, artifact tabs and blank tabs are refused. */
const READABLE = /^(https?|file):/i
const PDF_URL = /\.pdf($|[?#])/i

/** Reads a response body up to a byte cap, so a huge download never fills memory. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new IntakeError(mainT('intake.reason.pageTooLarge'))
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new IntakeError(mainT('intake.reason.pageTooLarge'))
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function hostFor(ctx: AppContext): IntakeHost {
  const tabOf = (tabId: string): Tab | undefined => ctx.tabsRegistry.get(tabId)
  const windowOf = (tabId: string) => {
    const id = ctx.tabsRegistry.windowOf(tabId)
    return id === undefined ? undefined : ctx.windows.get(id)
  }
  const tabInfo = (tabId: string) => {
    const tab = tabOf(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) return null
    const info = windowOf(tabId)?.tabs.info(tab)
    const url = info?.url ?? tab.view.webContents.getURL()
    return { url, title: info?.title ?? tab.view.webContents.getTitle(), favicon: info?.favicon ?? tab.favicon, internal: Boolean(tab.internalUrl) || Boolean(tab.sandbox) || !READABLE.test(url) }
  }
  const fetchFromTab = async (tabId: string, url: string, maxBytes: number) => {
    const tab = tabOf(tabId)
    if (!tab || tab.view.webContents.isDestroyed()) throw new IntakeError(mainT('intake.reason.tabGone'))
    if (url.startsWith('data:')) {
      const response = await fetch(url)
      return { bytes: await readCapped(response, maxBytes), contentType: response.headers.get('content-type') ?? '' }
    }
    if (!/^https?:/i.test(url)) throw new IntakeError(mainT('intake.reason.pageFetchFailed'))
    // Through the tab's own session, so the page's cookies apply as they did for the page.
    const response = await tab.view.webContents.session.fetch(url, { headers: { referer: tab.view.webContents.getURL() } })
    if (!response.ok) throw new IntakeError(mainT('intake.reason.pageFetchFailed'))
    return { bytes: await readCapped(response, maxBytes), contentType: response.headers.get('content-type') ?? '' }
  }
  const chatSaved = (chatId: string): boolean => ctx.maintenance.chats.summary(chatId) !== undefined
  const capabilities = (chatId: string) => {
    try {
      return chatSaved(chatId) ? ctx.maintenance.chats.load(chatId).capabilities : null
    } catch {
      return null
    }
  }

  return {
    sources: {
      tab: tabInfo,
      async readTab(tabId) {
        const tab = tabOf(tabId)
        const info = tabInfo(tabId)
        if (!tab || !info) throw new IntakeError(mainT('intake.reason.tabGone'))
        // A PDF tab shows Chromium's viewer, where the page bridge doesn't run: read the file itself.
        if (PDF_URL.test(info.url)) {
          const got = await fetchFromTab(tabId, info.url, 32_000_000).catch(() => null)
          if (got && /^application\/pdf/i.test(got.contentType)) return { pdf: got.bytes }
        }
        const bridge = ctx.intakeHosts?.bridge
        if (!bridge) throw new IntakeError(mainT('intake.reason.tabUnreadable'))
        const text = await bridge.request<string>(tab.view.webContents, { op: 'getText' })
        return { text: typeof text === 'string' ? text : '' }
      },
      fetchFromTab,
      chatTitle: (chatId) => ctx.maintenance.chats.summary(chatId)?.title ?? null,
      chatMarkdown(chatId) {
        try {
          return ctx.agent.markdown(chatId)
        } catch {
          return null
        }
      },
      skill(skillId) {
        const store = ctx.intakeHosts?.skills
        const skill = store ? store.get(skillId) : (readJson(join(ctx.dataDir, 'skills.json')) as { id?: string; name?: string; instructions?: string }[] | undefined)?.find((s) => s?.id === skillId)
        return skill && typeof skill.name === 'string' && typeof skill.instructions === 'string' ? { name: skill.name, instructions: skill.instructions } : null
      },
      async meeting(meetingId) {
        try {
          return await ctx.personal.meetings.resolver.forPrompt(meetingId)
        } catch {
          return null
        }
      },
      record: (connectorId, uri) => ctx.content.connectors.readRecord(connectorId, uri),
    },
    images: createPreprocessor({
      session: sandboxSession(PREPROCESS_PARTITION),
      rendererRoot: join(__dirname, '../renderer'),
      devUrl: devRendererUrl(),
    }),
    pdf: workerPdfReader(),
    heic(path) {
      if (process.platform !== 'darwin') return null
      const image = nativeImage.createFromPath(path)
      return image.isEmpty() ? null : image.toJPEG(92)
    },
    // Other engines read office files' text on this computer, so only the API key needs Files and documents for them.
    documentsOn: (chatId) => {
      const caps = capabilities(chatId)
      if (engineHasOwnAccount(caps ? caps.engine : ctx.settings.get().engine)) return true
      return caps?.documents ?? ctx.settings.get().documents
    },
    model: (chatId) => capabilities(chatId)?.model ?? ctx.settings.get().model,
    chat(chatId) {
      const summary = ctx.maintenance.chats.summary(chatId)
      if (!summary) return null
      try {
        const content = ctx.maintenance.chats.load(chatId)
        return { messages: content.messages, log: content.log, updatedAt: summary.updatedAt }
      } catch {
        return null
      }
    },
    generated(chatId) {
      try {
        return ctx.content.libraryFiles.listByChat(chatId)
      } catch {
        return []
      }
    },
    controlledTabs: (chatId) => Object.entries(ctx.agent.tabOwners()).filter(([, owner]) => owner === chatId).map(([tabId]) => tabId),
    focusTab(tabId) {
      const win = windowOf(tabId)
      if (!win) throw new Error(mainT('intake.reason.tabGone'))
      win.tabs.activate(tabId)
      if (win.window.isMinimized()) win.window.restore()
      win.window.focus()
    },
    closeTab(tabId) {
      const win = windowOf(tabId)
      if (!win) throw new Error(mainT('intake.reason.tabGone'))
      win.tabs.close(tabId)
    },
    async pickFiles() {
      const parent = BrowserWindow.getFocusedWindow()
      const options = { properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      return result.canceled ? [] : result.filePaths
    },
    reveal: (path) => shell.showItemInFolder(path),
  }
}

/** The running intake, for the intake smoke checks (main-only reads such as prepared files). */
let running: ReturnType<typeof setupIntake> | null = null
export const intakeSmokeHooks = (): ReturnType<typeof setupIntake> | null => (process.env.APEX_SMOKE === '1' ? running : null)

export function createIntakeFeature(): Feature {
  const undo: (() => void)[] = []
  let intake: ReturnType<typeof setupIntake> | null = null
  return {
    name: 'intake',
    app(ctx) {
      // The hidden preprocessing renderer loads only its own page; every other request is cancelled.
      const dev = devRendererUrl()
      const devOrigin = dev ? new URL(dev).origin : undefined
      sandboxSession(PREPROCESS_PARTITION, (d) => preprocessAllow(d.url, devOrigin))
      const started = setupIntake({ dataDir: ctx.dataDir, broadcast: ctx.broadcast, host: hostFor(ctx) })
      intake = started
      running = started
      ctx.content.attachments = started.store
      ctx.content.chatContext = started.context
      ctx.content.chatFiles = started.chatFiles
      // Deleted chats take their attachments and pages with them.
      const onRemoved = (ids: string[]): void => started.chatsRemoved(ids)
      ctx.maintenance.chats.on('removed', onRemoved)
      undo.push(() => ctx.maintenance.chats.off('removed', onRemoved))
      // MV-14: attached meetings re-check their transcript whenever the meetings change.
      try {
        ctx.personal.meetings.store.on('changed', () => started.meetingsChanged())
      } catch (err) {
        log.debug('intake', 'Meetings are not available yet', { error: err instanceof Error ? err.message : String(err) })
      }
      setTimeout(() => started.sweep((chatId) => ctx.maintenance.chats.summary(chatId) !== undefined), 30_000).unref?.()
      undo.push(
        registerStorageCategory({
          id: 'chat-attachments',
          label: mainT('intake.storage.chatAttachments'),
          order: 25,
          measure: async () => started.store.sizes().chatAttachments,
          clear: {
            label: mainT('intake.storage.pruneImages'),
            run: async () => {
              started.store.pruneImages(30)
            },
          },
        }),
        started.dispose,
      )
      return started.services
    },
    tab(tab) {
      return () => intake?.tabClosed(tab.id)
    },
    dispose: () => {
      running = null
      for (const fn of undo.splice(0)) fn()
    },
  }
}
