/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainEvent } from 'electron'
import { z } from 'zod'
import { PAGE, PAGE_LINK_HREF_MAX, type PageLinkMessage } from '@shared/ipc'
import { canPeek } from '@shared/links'
import type { WindowContext } from './features/types'
import { addressSurfacesOf } from './addressSurfaces'
import { linkPreview } from './linkPreview'
import { log } from './log'
import type { Tab } from './tabs'
import type { WindowManager } from './windows'

// Main's half of link gestures (SH-46): PAGE.links from the
// page preload, and update-target-url for the link bubble. Messages are
// accepted only from a known tab's main frame and validated with zod.

const pageRect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()
const linkMessage = z
  .object({ kind: z.enum(['alt-hover', 'long-press', 'shift-click', 'leave']), href: z.string().max(PAGE_LINK_HREF_MAX), rect: pageRect })
  .strict() satisfies z.ZodType<PageLinkMessage>

/** The page's viewport px in the chrome's CSS px, relative to the tab's pane. */
function toChromeRect(rect: PageLinkMessage['rect'], tab: Tab, win: WindowContext): PageLinkMessage['rect'] {
  const page = tab.view.webContents.getZoomFactor() || 1
  const chrome = win.chrome.getZoomFactor() || 1
  const k = page / chrome
  return { x: rect.x * k, y: rect.y * k, width: rect.width * k, height: rect.height * k }
}

export function installLinkGestures(windows: WindowManager): () => void {
  // One preview request at a time per tab; a newer hover aborts the older one.
  const pending = new Map<string, AbortController>()

  const listener = (event: IpcMainEvent, raw: unknown): void => {
    const parsed = linkMessage.safeParse(raw)
    if (!parsed.success || event.senderFrame !== event.sender.mainFrame) return
    const win = windows.fromWebContents(event.sender.id)
    const tab = win?.tabs.byWebContents(event.sender)
    if (!win || !tab) return
    const message = parsed.data
    pending.get(tab.id)?.abort()
    pending.delete(tab.id)
    if (message.kind === 'leave') {
      win.send({ type: 'link-preview', tabId: tab.id, url: '', rect: null, preview: null })
      addressSurfacesOf(win)?.linkPreview(tab, '', null, null, false)
      return
    }
    if (!canPeek(message.href)) return
    if (message.kind === 'shift-click') {
      try {
        win.peek.open(message.href)
      } catch (err) {
        log.warn('links', 'Peek refused a link', { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }
    if (!/^https?:/i.test(message.href)) return
    const rect = toChromeRect(message.rect, tab, win)
    const controller = new AbortController()
    pending.set(tab.id, controller)
    // The card shows at once in its loading state, then fills in.
    win.send({ type: 'link-preview', tabId: tab.id, url: message.href, rect, preview: null })
    addressSurfacesOf(win)?.linkPreview(tab, message.href, rect, null, false)
    void linkPreview(message.href, controller.signal).then((preview) => {
      if (controller.signal.aborted) return
      pending.delete(tab.id)
      win.send({ type: 'link-preview', tabId: tab.id, url: message.href, rect, preview, ...(preview ? {} : { failed: true }) })
      addressSurfacesOf(win)?.linkPreview(tab, message.href, rect, preview, !preview)
    })
  }
  ipcMain.on(PAGE.links, listener)
  return () => {
    ipcMain.off(PAGE.links, listener)
    for (const c of pending.values()) c.abort()
    pending.clear()
  }
}

/** The link bubble's feed for one tab: the hovered address, or null. */
export function watchTargetUrl(tab: Tab, win: WindowContext): () => void {
  const wc = tab.view.webContents
  let last: string | null = null
  const onTarget = (_e: unknown, url: string): void => {
    const next = url || null
    if (next === last) return
    last = next
    win.send({ type: 'link-hover', tabId: tab.id, url: next })
    addressSurfacesOf(win)?.linkHover(tab, next)
  }
  wc.on('update-target-url', onTarget)
  return () => {
    if (!wc.isDestroyed()) wc.off('update-target-url', onTarget)
  }
}
