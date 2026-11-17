/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Preload for the browser chrome only. Web pages never receive this bridge;
// main also rejects UI channels from any sender other than the chrome.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ApexApi } from '@shared/api'
import type { ChatAgentEvent } from '@shared/chats'
import { UI, type InitialState } from '@shared/ipc'
import type { UiRole } from '@shared/overlay'

// Overlay tiers, popup strips and drag ghosts load the same UI with a hash.
function roleFromHash(hash: string): UiRole {
  if (hash === '#overlay=interactive') return 'overlay-interactive'
  if (hash === '#overlay=passive') return 'overlay-passive'
  if (hash === '#popup-strip') return 'popup-strip'
  if (hash === '#ghost') return 'ghost'
  return 'chrome'
}

// One IPC listener per channel fans out to every subscriber: many views
// follow the same events, and ipcRenderer warns past ten listeners.
const subscribers = new Map<string, Set<(payload: unknown) => void>>()

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  let set = subscribers.get(channel)
  if (!set) {
    const listeners = new Set<(payload: unknown) => void>()
    set = listeners
    subscribers.set(channel, listeners)
    ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => {
      for (const fn of [...listeners]) {
        try {
          fn(payload)
        } catch (err) {
          // One failing view must not stop the others from hearing the event.
          console.error(err)
        }
      }
    })
  }
  const fn = listener as (payload: unknown) => void
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

const api: ApexApi = {
  tabs: {
    create: (url, options) => ipcRenderer.invoke(UI.tabsCreate, url, options),
    close: (tabId) => ipcRenderer.invoke(UI.tabsClose, tabId),
    activate: (tabId) => ipcRenderer.invoke(UI.tabsActivate, tabId),
    onChanged: (listener) => subscribe(UI.tabsChanged, listener),
  },
  nav: {
    go: (tabId, input) => ipcRenderer.invoke(UI.navigate, tabId, input),
    back: (tabId) => ipcRenderer.invoke(UI.back, tabId),
    forward: (tabId) => ipcRenderer.invoke(UI.forward, tabId),
    reload: (tabId, bypassCache) => ipcRenderer.invoke(UI.reload, tabId, bypassCache),
    stop: (tabId) => ipcRenderer.invoke(UI.stop, tabId),
    suggest: (input) => ipcRenderer.invoke(UI.suggest, input),
  },
  layout: {
    setLayout: (layout) => ipcRenderer.send(UI.layout, layout),
    setOverlayOpen: (open) => ipcRenderer.send(UI.overlay, open),
  },
  agent: {
    start: (text, options) => ipcRenderer.invoke(UI.agentStart, text, options),
    send: (chatId, text, attachments) => ipcRenderer.invoke(UI.agentSend, chatId, text, attachments),
    stop: (chatId) => ipcRenderer.invoke(UI.agentStop, chatId),
    approve: (chatId, approvalId, allowed) => ipcRenderer.invoke(UI.agentApprove, chatId, approvalId, allowed),
    // CH-40
    approveConnector: (chatId, approvalId, response) => ipcRenderer.invoke(UI.agentApproveConnector, chatId, approvalId, response),
    onEvent: (listener) => subscribe<ChatAgentEvent>(UI.agentEvent, ({ chatId, seq, event }) => listener(event, { chatId, seq })),
  },
  settings: {
    get: () => ipcRenderer.invoke(UI.settingsGet),
    set: (patch) => ipcRenderer.invoke(UI.settingsSet, patch),
    setApiKey: (key) => ipcRenderer.invoke(UI.apiKeySet, key),
  },
  invoke: (service, method, ...args) => ipcRenderer.invoke(UI.invoke, service, method, args),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  onAppEvent: (listener) => subscribe(UI.appEvent, listener),
  onCommand: (listener) => subscribe(UI.command, listener),
  overlay: {
    open: (surface, anchor, props) => ipcRenderer.invoke(UI.overlayOpen, surface, anchor, props),
    update: (instanceId, props) => ipcRenderer.send(UI.overlayUpdate, instanceId, props),
    close: (instanceId) => ipcRenderer.send(UI.overlayClose, instanceId),
    onResult: (fn) => subscribe(UI.overlayResult, fn),
    prewarm: (surface) => ipcRenderer.send(UI.overlayPrewarm, surface),
    onOpen: (fn) => subscribe(UI.overlayShow, fn),
    onClose: (fn) => subscribe(UI.overlayHide, fn),
    reportBounds: (instanceId, rect) => ipcRenderer.send(UI.overlayBounds, instanceId, rect),
    resolve: (instanceId, value) => ipcRenderer.send(UI.overlayResolve, instanceId, value),
    removed: (instanceId) => ipcRenderer.send(UI.overlayRemoved, instanceId),
    mounted: (instanceId, policy) => ipcRenderer.send(UI.overlayMounted, instanceId, policy),
    dismiss: (instanceId, reason) => ipcRenderer.send(UI.overlayDismiss, instanceId, reason),
    onStrip: (fn) => {
      const off = subscribe(UI.popupStrip, fn)
      // Asks for the current state once subscribed, so the first paint is not empty.
      ipcRenderer.send(UI.popupStrip)
      return off
    },
  },
  role: roleFromHash(window.location.hash),
  platform: process.platform,
  // Synchronous on purpose: the theme, accent and layout must be known before
  // the first paint, or the default theme flashes.
  initial: ipcRenderer.sendSync(UI.initialState) as InitialState,
}

contextBridge.exposeInMainWorld('apex', api)
