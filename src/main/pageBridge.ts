/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { PAGE, type PageCommand, type PageReply, type PageRequest } from '@shared/ipc'

interface Pending {
  webContentsId: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Request/response channel from main to the agent bridge preload in a tab. */
export class PageBridge {
  #nextId = 1
  readonly #pending = new Map<number, Pending>()

  constructor() {
    ipcMain.on(PAGE.reply, (event, reply: unknown) => this.#onReply(event, reply))
  }

  request<T>(webContents: WebContents, command: PageCommand, timeoutMs = 10_000): Promise<T> {
    if (webContents.isDestroyed()) return Promise.reject(new Error('The tab was closed.'))
    const requestId = this.#nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new Error('The page did not respond in time. It may still be loading; wait and try again.'))
      }, timeoutMs)
      this.#pending.set(requestId, {
        webContentsId: webContents.id,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      const request: PageRequest = { requestId, command }
      webContents.send(PAGE.command, request)
    })
  }

  /** Fails outstanding requests when a tab's document goes away. */
  rejectAll(webContentsId: number, reason: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.webContentsId !== webContentsId) continue
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(new Error(reason))
    }
  }

  #onReply(event: IpcMainEvent, reply: unknown): void {
    if (!isPageReply(reply)) return
    const pending = this.#pending.get(reply.requestId)
    if (!pending) return
    // Only the main frame of the tab the request went to may answer it.
    if (event.sender.id !== pending.webContentsId || event.senderFrame !== event.sender.mainFrame) return
    clearTimeout(pending.timer)
    this.#pending.delete(reply.requestId)
    if (reply.ok) pending.resolve(reply.result)
    else pending.reject(new Error(reply.error))
  }
}

function isPageReply(value: unknown): value is PageReply {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.requestId === 'number' && (v.ok === true || (v.ok === false && typeof v.error === 'string'))
}
