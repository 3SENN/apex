/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { z } from 'zod'
import { ENGINES } from '@shared/engine'
import { UI, type InitialState, type Suggestion } from '@shared/ipc'
import type { AppEvent } from '@shared/services'
import { isDestinationUrl, omniboxToUrl, searchUrl } from '@shared/url'
import type { AdBlocker } from './adblock'
import type { AgentHost } from './agent/host'
import { messageAttachmentsSchema } from './agent/messageAttachments'
import { approveConnectorArgs } from './agent/richChatSchemas'
import { COMPANION_ID, EFFORTS } from './companions'
import type { HistoryStore } from './history'
import type { PeekManager } from './peek'
import { MODELS, type SettingsStore } from './settings'
import { profileOfContents } from './profiles/windowProfiles'
import type { TabManager } from './tabs'
import { mainT } from './i18n/mainT'
import { httpsUpgrades } from './privacy/httpsFirst'

interface IpcDeps {
  ui: WebContents
  tabs: TabManager
  agent: AgentHost
  settings: SettingsStore
  history: HistoryStore
  adblock: AdBlocker
  webSession: Session
  peek: PeekManager
  /** Theme, settings, window state and tabs for the preload's synchronous read. */
  initialState: () => InitialState
  sendEvent: (event: AppEvent) => void
}

interface SenderLike {
  sender: unknown
  senderFrame: unknown
}

// Each UI channel acts on the sender's own window
/** The window-scoped parts a UI channel acts on. */
export interface IpcWindow {
  ui: WebContents
  tabs: TabManager
  peek: PeekManager
  webSession: Session
  initialState: () => InitialState
  sendEvent: (event: AppEvent) => void
}

type IpcRouter = (event: IpcMainEvent | IpcMainInvokeEvent) => IpcWindow | null
let router: IpcRouter | null = null

/** Windows after the first, and every window's overlay renderers and popup strips, resolve through this. */
export function setIpcWindowRouter(fn: IpcRouter | null): void {
  router = fn
}

/** UI channels only accept messages from the chrome's own main frame. */
export function isTrustedUiSender(event: SenderLike, ui: { mainFrame: unknown }): boolean {
  return event.sender === ui && event.senderFrame !== null && event.senderFrame === ui.mainFrame
}

const tabId = z.string().min(1).max(64)
const boundsSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
})

export function registerIpc(deps: IpcDeps): void {
  const { agent, settings, history, adblock } = deps
  const first: IpcWindow = { ui: deps.ui, tabs: deps.tabs, peek: deps.peek, webSession: deps.webSession, initialState: deps.initialState, sendEvent: deps.sendEvent }
  // The first window's chrome answers directly; any other sender goes through the router (null rejects it).
  const windowOf = (event: IpcMainEvent | IpcMainInvokeEvent): IpcWindow | null => (isTrustedUiSender(event, first.ui) ? first : (router?.(event) ?? null))
  // The window the current call acts on; set per call before the handler runs (handlers are synchronous up to their first await).
  let w: IpcWindow = first
  // Argument types come from each channel's tuple schema.
  const handle = <S extends z.ZodType<unknown[]>>(channel: string, schema: S, fn: (...args: z.output<S>) => unknown): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      const win = windowOf(event)
      if (!win) throw new Error('Rejected IPC from an untrusted sender.')
      w = win
      return fn(...schema.parse(raw))
    })
  }
  const on = <S extends z.ZodType<unknown[]>>(channel: string, schema: S, fn: (...args: z.output<S>) => void): void => {
    ipcMain.on(channel, (event: IpcMainEvent, ...raw: unknown[]) => {
      const win = windowOf(event)
      if (!win) return
      const parsed = schema.safeParse(raw)
      if (!parsed.success) return
      w = win
      fn(...parsed.data)
    })
  }

  const newTabOptions = z.object({ background: z.boolean().optional(), afterId: tabId.optional(), position: z.enum(['top', 'end']).optional() }).strict()
  handle(UI.tabsCreate, z.tuple([z.string().max(8192).nullable().optional(), newTabOptions.optional()]), (url, options = {}) => {
    const target = url ? omniboxToUrl(url, settings.getFor(profileOfCall()).searchEngine) : 'about:blank'
    // Without a placement, ⌘T semantics: the sidebar adds new tabs at the top, the strip at the end.
    const position = options.position ?? (options.afterId ? undefined : settings.getFor(profileOfCall()).layout === 'sidebar' ? 'top' : 'end')
    w.tabs.create(target, { activate: !options.background, afterId: options.afterId, position })
  })
  handle(UI.tabsClose, z.tuple([tabId]), (id) => w.tabs.close(id))
  handle(UI.tabsActivate, z.tuple([tabId]), (id) => w.tabs.activate(id))
  handle(UI.navigate, z.tuple([tabId, z.string().max(8192)]), (id, input) => {
    const url = omniboxToUrl(input, settings.getFor(profileOfCall()).searchEngine)
    // Typing a destination's address shows it on the destination surface, not in the tab (DS-99).
    if (isDestinationUrl(url)) w.tabs.openInternal(url)
    else {
      // HTTPS-First (PV-01): a typed bare host that fails over https offers its http address.
      const wc = w.tabs.get(id)?.view?.webContents
      if (wc && !wc.isDestroyed()) httpsUpgrades.typed(wc.id, input, url)
      w.tabs.navigate(id, url)
    }
  })
  handle(UI.back, z.tuple([tabId]), (id) => w.tabs.back(id))
  handle(UI.forward, z.tuple([tabId]), (id) => w.tabs.get(id).view.webContents.navigationHistory.goForward())
  handle(UI.reload, z.tuple([tabId, z.boolean().optional()]), (id, bypassCache) => {
    // The chrome draws atelier:// pages and the new tab; reloading the hidden page under them would do nothing visible.
    // The id goes along: the tab menu can reload a background tab, not only the active one.
    // Reload on a destination remounts the destination page ('rail').
    if (w.tabs.rail() !== null && id === w.tabs.activeId()) w.sendEvent({ type: 'reload-page', tabId: 'rail' })
    else if (w.tabs.isChromeDrawn(w.tabs.get(id))) w.sendEvent({ type: 'reload-page', tabId: id })
    else w.tabs.reload(id, bypassCache)
  })
  handle(UI.stop, z.tuple([tabId]), (id) => w.tabs.get(id).view.webContents.stop())
  handle(UI.suggest, z.tuple([z.string().max(2048)]), (input): Suggestion[] => {
    const text = input.trim()
    if (!text) return []
    const engine = settings.getFor(profileOfCall()).searchEngine
    const target = omniboxToUrl(text, engine)
    const first: Suggestion = target === searchUrl(text, engine)
      ? { url: target, title: mainT('core.mainIpc.searchFor', { text }), kind: 'search' }
      : { url: target, title: target, kind: 'url' }
    const fromHistory = history.suggest(text).filter((h) => h.url !== first.url)
    return [first, ...fromHistory.map((h): Suggestion => ({ url: h.url, title: h.title || h.url, kind: 'history' }))]
  })

  // The chrome measures in CSS pixels; views are placed in window pixels, which differ once the chrome is zoomed.
  const round = (b: z.infer<typeof boundsSchema>) => {
    const zoom = w.ui.getZoomFactor() || 1
    return { x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.round(b.width * zoom), height: Math.round(b.height * zoom) }
  }
  const layoutSchema = z.object({ primary: boundsSchema, secondary: boundsSchema.nullable(), peek: boundsSchema.nullable(), radius: z.number().finite().min(0).max(32).optional() })
  on(UI.layout, z.tuple([layoutSchema]), (layout) => {
    const radius = layout.radius === undefined ? undefined : Math.round(layout.radius * (w.ui.getZoomFactor() || 1))
    w.tabs.setLayout({ primary: round(layout.primary), secondary: layout.secondary && round(layout.secondary), peek: layout.peek && round(layout.peek), radius })
    w.peek.setBounds(layout.peek && round(layout.peek))
  })
  on(UI.overlay, z.tuple([z.boolean()]), (open) => w.tabs.setHidden('overlay', open))

  // Runs happen in the background; progress arrives as agent events tagged with the chat.
  const chatId = z.string().regex(/^[0-9a-f-]{36}$/)
  const message = z.string().min(1).max(20_000)
  const newChat = z.object({ companionId: z.string().regex(COMPANION_ID).optional(), model: z.enum(MODELS).optional(), effort: z.enum(EFFORTS).optional(), engine: z.enum(ENGINES).optional() }).strict()
  // Attachments ride along with the options on start and as a third argument on send.
  const startOptions = newChat.extend({ attachments: messageAttachmentsSchema.optional() }).strict()
  handle(UI.agentStart, z.tuple([message, startOptions.optional()]), (text, options) => {
    const { attachments, ...rest } = options ?? {}
    return agent.start(text, rest, attachments)
  })
  handle(UI.agentSend, z.tuple([chatId, message, messageAttachmentsSchema.optional()]), (id, text, attachments) => agent.send(id, text, attachments))
  handle(UI.agentStop, z.tuple([chatId]), (id) => agent.stop(id))
  handle(UI.agentApprove, z.tuple([chatId, z.string().uuid(), z.boolean()]), (id, approvalId, allowed) => agent.approve(id, approvalId, allowed))
  // CH-40; the host routes the response into the chat's session
  handle(UI.agentApproveConnector, approveConnectorArgs, (id, approvalId, response) =>
    agent.approveConnector(id, approvalId, response.allowed ? { allowed: true, input: response.input } : { allowed: false, ...(response.message ? { message: response.message } : {}) }),
  )

  // Each window reads and patches its own profile's settings; app keys reach every profile
  const profileOfCall = (): string => profileOfContents(w.ui)
  handle(UI.settingsGet, z.tuple([]), () => settings.viewFor(profileOfCall()))
  handle(UI.settingsSet, z.tuple([z.unknown()]), async (patch) => {
    const win = w
    const profileId = profileOfCall()
    const before = settings.getFor(profileId)
    const next = settings.updateFor(profileId, patch)
    // Ad blocking is a profile value: it follows that profile's session.
    if (next.adblock !== before.adblock) await adblock.setEnabled(win.webSession, next.adblock).catch(() => undefined)
    // The store emits 'changed' and 'profileChanged'; main forwards them to that profile's windows from there.
    return settings.viewFor(profileId)
  })
  handle(UI.apiKeySet, z.tuple([z.string().max(512).nullable()]), (key) => {
    const profileId = profileOfCall()
    settings.setApiKey(key)
    return settings.viewFor(profileId)
  })
  // Synchronous by design (see the preload): always answer, or the chrome would hang.
  ipcMain.on(UI.initialState, (event: IpcMainEvent) => {
    event.returnValue = windowOf(event)?.initialState() ?? null
  })
}
