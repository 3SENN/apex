/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatEventMeta, MessageAttachmentInput, NewChatOptions } from './chats'
import type { AppEvent, LayoutBounds, MethodName, ServiceArgs, ServiceName, ServiceResult } from './services'
import type { OverlayOpenMessage, OverlayResult, Rect, SurfaceAnchor, SurfaceId, SurfacePolicy, SurfaceProps, UiRole } from './overlay'
import type {
  AgentEvent,
  InitialState,
  MenuCommand,
  SettingsPatch,
  SettingsView,
  Suggestion,
  TabsSnapshot,
} from './ipc'

/** Where a new tab goes. Without options, ⌘T semantics: top of the list in the sidebar layout, the end in the horizontal one. */
export interface NewTabOptions {
  /** Open without activating (⌘-click, middle-click). */
  background?: boolean
  /** Insert right after this tab ("new tab next to this one"). */
  afterId?: string
  /** 'top' is just below the pinned tabs (the sidebar's New Tab row). */
  position?: 'top' | 'end'
}

type Unsubscribe = () => void

/** The bridge the UI preload exposes to the browser chrome as `window.apex`. */
export interface ApexApi {
  tabs: {
    create(url?: string, options?: NewTabOptions): Promise<void>
    close(tabId: string): Promise<void>
    activate(tabId: string): Promise<void>
    onChanged(listener: (snapshot: TabsSnapshot) => void): Unsubscribe
  }
  nav: {
    go(tabId: string, input: string): Promise<void>
    back(tabId: string): Promise<void>
    forward(tabId: string): Promise<void>
    /** On an apex:// page this remounts the page instead (a 'reload-page' command). */
    reload(tabId: string, bypassCache?: boolean): Promise<void>
    stop(tabId: string): Promise<void>
    suggest(input: string): Promise<Suggestion[]>
  }
  layout: {
    setLayout(layout: LayoutBounds): void
    setOverlayOpen(open: boolean): void
  }
  /** Calls a feature service in main; arguments are validated there. */
  invoke<S extends ServiceName, M extends MethodName<S>>(service: S, method: M, ...args: ServiceArgs<S, M>): Promise<Awaited<ServiceResult<S, M>>>
  /** A dropped File's path on disk (Electron's webUtils), or null for one that isn't a disk file. */
  pathForFile?(file: File): string | null
  onAppEvent(listener: (event: AppEvent) => void): Unsubscribe
  /**
   * One session per chat. Every event comes with its chat id and a sequence
   * number: subscribe once, keep the events of the chat you show, and skip
   * those with `seq` at or below the `seq` of the ChatView you loaded.
   */
  agent: {
    /** Starts a new chat with its first message and resolves to its id. Progress arrives as events. */
    start(text: string, options?: NewChatOptions & { /** may carry refs (at most 20) */ attachments?: MessageAttachmentInput[] }): Promise<string>
    /** Sends to a draft or saved chat. While the chat runs, the message is queued (see the 'chat-queue' app event). */
    send(chatId: string, text: string, /** may carry refs (at most 20) */ attachments?: MessageAttachmentInput[]): Promise<{ queued: boolean }>
    /** Stops the run and drops the queue; resolves to the queued texts that were not sent, so they can go back in the composer. */
    stop(chatId: string): Promise<string[]>
    approve(chatId: string, approvalId: string, allowed: boolean): Promise<void>
    /** CH-40: answers a connector tool approval; an edited `input` is validated against the tool's schema in main. */
    approveConnector(chatId: string, approvalId: string, response: { allowed: true; input: unknown } | { allowed: false; message?: string }): Promise<void>
    onEvent(listener: (event: AgentEvent, meta: ChatEventMeta) => void): Unsubscribe
  }
  settings: {
    get(): Promise<SettingsView>
    set(patch: SettingsPatch): Promise<SettingsView>
    setApiKey(key: string | null): Promise<SettingsView>
  }
  onCommand(listener: (command: MenuCommand) => void): Unsubscribe
  overlay: OverlayApi
  /** Which renderer this is: the chrome, an overlay tier, a popup's origin strip or a drag ghost. */
  role: UiRole
  platform: string
  /** Read synchronously before the chrome renders: theme, settings, window state and tabs. Fresh after every chrome reload. */
  initial: InitialState
}

/** The overlay host's preload API. The chrome opens surfaces; overlay renderers mount them. */
export interface OverlayApi {
  // chrome side
  open<S extends SurfaceId>(surface: S, anchor: SurfaceAnchor, props: SurfaceProps<S>): Promise<{ instanceId: string }>
  update(instanceId: string, props: unknown): void
  close(instanceId: string): void
  onResult(fn: (r: OverlayResult) => void): Unsubscribe
  prewarm(surface: SurfaceId): void
  // overlay renderers
  onOpen(fn: (o: OverlayOpenMessage) => void): Unsubscribe
  onClose(fn: (o: { instanceId: string }) => void): Unsubscribe
  reportBounds(instanceId: string, rect: Rect): void
  resolve(instanceId: string, value: unknown): void
  /** The surface finished its exit and was unmounted. */
  removed(instanceId: string): void
  /** The surface mounted with this policy (main enforces it from then on). */
  mounted(instanceId: string, policy: SurfacePolicy): void
  /** Dismisses without a value: Escape, or the surface's own close. */
  dismiss(instanceId: string, reason: 'escape' | 'closed'): void
  /** Popup windows' origin strip (SH-62): its state, pushed by main. */
  onStrip(fn: (state: PopupStripState) => void): Unsubscribe
}

/** What a popup window's read-only origin strip shows (SH-62). */
export interface PopupStripState {
  host: string
  secure: boolean
  loading: boolean
  title: string
}
