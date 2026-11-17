/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ClipboardItem, ShareMenu, app, clipboard, dialog, nativeImage, shell, type NativeImage, type WebContents } from 'electron'
import type { Rect } from '@shared/overlay'
import { toWindowPx } from '@shared/overlayLayout'
import { PAGE_MARKDOWN_EXPRESSION, markdownLink } from '@shared/pageMarkdown'
import { qrBitmap, qrDataUrl, qrMatrix } from '@shared/qr'
import type { MenuServices } from '@shared/services/menus'
import { textFragmentUrl } from '@shared/textFragment'
import { viewSourceUrl } from '@shared/viewSource'
import { areaOf, openTracked, toasts } from './dialogs'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'
import type { Tab } from './tabs'

// Page actions (OV-05): copy the address, a
// Markdown link, the page as Markdown, a screenshot or a link to the
// highlight; print, save as PDF or complete HTML, share; the QR code, view
// source and developer tools. Each confirms with a toast. The tab menu and
// the link menu call these; the tab defaults to the active one.

/** Scripts that read the page run in a world of their own, out of the page's reach. */
const READ_WORLD = 1051

type PageActions = MenuServices['pageActions']

/** A file name from a page title: no path characters, not too long. */
export function safeFileName(title: string, fallback = 'page'): string {
  return title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || fallback
}

/** Electron's clipboard takes images as PNG blobs. */
function copyImage(image: NativeImage): Promise<void> {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })])
}

function isWebUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

export function createPageActions(win: WindowContext): PageActions {
  const tabOf = (tabId?: string): Tab | null => (tabId ? (win.tabs.find(tabId) ?? null) : win.tabs.active())
  const urlOf = (tab: Tab): string => tab.internalUrl ?? (tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL())
  const titleOf = (tab: Tab): string => win.tabs.info(tab).title
  /** A web page Apex can act on: not an apex:// page drawn by the chrome. */
  const webTab = (tabId?: string): Tab | null => {
    const tab = tabOf(tabId)
    if (!tab || win.tabs.isChromeDrawn(tab) || tab.view.webContents.isDestroyed()) return null
    return isWebUrl(tab.view.webContents.getURL()) ? tab : null
  }
  const toast = (text: string, kind: 'success' | 'error' | 'info' = 'success', tabId?: string, detail?: string): void => {
    void toasts.show(win, { kind, text, ...(detail ? { detail } : {}), ...(tabId ? { tabId } : {}) })
  }
  const notHere = (tabId?: string): void => toast(mainT('menus.pageAction.notOnApexPage'), 'error', tabId)
  const saved = (path: string, text: string, tabId?: string): void => {
    void toasts.show(win, { kind: 'success', text, detail: path, action: { id: 'reveal', label: mainT('menus.pageAction.showInFolder') }, ...(tabId ? { tabId } : {}) }).then((outcome) => {
      if (outcome === 'action') shell.showItemInFolder(path)
    })
  }
  const readPage = async <T>(wc: WebContents, code: string): Promise<T> => (await wc.executeJavaScriptInIsolatedWorld(READ_WORLD, [{ code }])) as T
  const saveTarget = async (name: string, ext: string, filter: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog(win.window, { defaultPath: join(app.getPath('downloads'), `${name}.${ext}`), filters: [{ name: filter, extensions: [ext] }] })
    return result.canceled || !result.filePath ? null : result.filePath
  }

  return {
    copyUrl(tabId) {
      const tab = tabOf(tabId)
      const url = tab ? urlOf(tab) : ''
      if (!url) return
      clipboard.writeText(url)
      toast(mainT('menus.pageAction.linkCopied'), 'success', tab?.id)
    },
    copyMarkdownLink(tabId) {
      const tab = tabOf(tabId)
      const url = tab ? urlOf(tab) : ''
      if (!tab || !url) return
      clipboard.writeText(markdownLink(titleOf(tab), url))
      toast(mainT('menus.pageAction.markdownLinkCopied'), 'success', tab.id)
    },
    async copyAsMarkdown(tabId) {
      const tab = webTab(tabId)
      if (!tab) return notHere(tabId)
      try {
        const md = await readPage<string>(tab.view.webContents, PAGE_MARKDOWN_EXPRESSION)
        clipboard.writeText(typeof md === 'string' ? md : '')
        toast(mainT('menus.pageAction.markdownCopied'), 'success', tab.id)
      } catch (err) {
        log.warn('page-actions', 'Copy as Markdown failed', { error: err instanceof Error ? err.message : String(err) })
        toast(mainT('menus.pageAction.markdownFailed'), 'error', tab.id)
      }
    },
    async screenshotToClipboard(tabId) {
      const tab = tabOf(tabId)
      if (!tab) return
      try {
        // An apex:// page is drawn by the chrome: capture its part of the window.
        const image = win.tabs.isChromeDrawn(tab) ? await win.chrome.capturePage(win.tabs.contentBounds()) : await tab.view.webContents.capturePage()
        if (image.isEmpty()) throw new Error('empty capture')
        await copyImage(image)
        toast(mainT('menus.pageAction.screenshotCopied'), 'success', tab.id)
      } catch (err) {
        log.warn('page-actions', 'Screenshot failed', { error: err instanceof Error ? err.message : String(err) })
        toast(mainT('menus.pageAction.screenshotFailed'), 'error', tab.id)
      }
    },
    async copyLinkToHighlight(tabId) {
      const tab = webTab(tabId)
      if (!tab) return notHere(tabId)
      let selection = ''
      try {
        selection = String((await readPage<string>(tab.view.webContents, 'String(getSelection() || "")')) ?? '')
      } catch {
        selection = ''
      }
      const link = textFragmentUrl(tab.view.webContents.getURL(), selection)
      if (!link) return toast(mainT(selection.trim() ? 'menus.pageAction.highlightFailed' : 'menus.pageAction.highlightNone'), 'error', tab.id)
      clipboard.writeText(link)
      toast(mainT('menus.pageAction.highlightCopied'), 'success', tab.id)
    },
    print(tabId) {
      const tab = webTab(tabId)
      if (!tab) return notHere(tabId)
      tab.view.webContents.print({}, (ok, reason) => {
        if (!ok && reason && reason !== 'Print job canceled' && reason !== 'cancelled') toast(mainT('menus.pageAction.printFailed'), 'error', tab.id, reason)
      })
    },
    async saveAsPdf(tabId) {
      const tab = webTab(tabId)
      if (!tab) {
        notHere(tabId)
        return null
      }
      const path = await saveTarget(safeFileName(titleOf(tab)), 'pdf', 'PDF')
      if (!path) return null
      try {
        const pdf = await tab.view.webContents.printToPDF({ printBackground: true })
        await writeFile(path, pdf)
        saved(path, mainT('menus.pageAction.pdfSaved'), tab.id)
        return path
      } catch (err) {
        log.warn('page-actions', 'Save as PDF failed', { error: err instanceof Error ? err.message : String(err) })
        toast(mainT('menus.pageAction.saveFailed'), 'error', tab.id)
        return null
      }
    },
    async savePage(tabId) {
      const tab = webTab(tabId)
      if (!tab) {
        notHere(tabId)
        return null
      }
      const path = await saveTarget(safeFileName(titleOf(tab)), 'html', mainT('menus.pageAction.webPageComplete'))
      if (!path) return null
      try {
        await tab.view.webContents.savePage(path, 'HTMLComplete')
        saved(path, mainT('menus.pageAction.pageSaved'), tab.id)
        return path
      } catch (err) {
        log.warn('page-actions', 'Save page failed', { error: err instanceof Error ? err.message : String(err) })
        toast(mainT('menus.pageAction.saveFailed'), 'error', tab.id)
        return null
      }
    },
    share(tabId, anchor?: Rect) {
      const tab = tabOf(tabId)
      const url = tab ? urlOf(tab) : ''
      if (!tab || !isWebUrl(url)) return notHere(tabId)
      if (process.platform !== 'darwin') {
        // No system share sheet here: copying the link is the closest thing.
        clipboard.writeText(url)
        return toast(mainT('menus.pageAction.linkCopied'), 'success', tab.id, mainT('menus.pageAction.shareUnavailable'))
      }
      const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
      const at = anchor ? toWindowPx(anchor, zoom) : null
      new ShareMenu({ urls: [url], texts: [titleOf(tab)] }).popup({ window: win.window, ...(at ? { x: at.x, y: at.y + at.height } : {}) })
    },
    qrCode(tabId) {
      const tab = tabOf(tabId)
      const url = tab ? urlOf(tab) : ''
      if (!isWebUrl(url)) throw new Error(mainT('menus.qr.notAvailable'))
      return qrDataUrl(url)
    },
    viewSource(tabId) {
      const tab = webTab(tabId)
      if (!tab) return notHere(tabId)
      win.tabs.openInternal(viewSourceUrl(tab.view.webContents.getURL()), { newTab: true })
    },
    devtools(target) {
      const wc = devtoolsTarget(win, target === 'chrome')
      if (!wc) return shell.beep()
      openDevtools(wc, target)
    },
    copyQrCode(url) {
      copyImage(qrImage(url)).then(
        () => toast(mainT('menus.qr.copied')),
        () => toast(mainT('menus.qr.copyFailed'), 'error'),
      )
    },
    async saveQrCode(url) {
      let host = 'page'
      try {
        host = new URL(url).hostname.replace(/^www\./, '') || host
      } catch {
        // The fallback name will do.
      }
      const path = await saveTarget(safeFileName(`${host} QR code`), 'png', 'PNG')
      if (!path) return null
      await writeFile(path, qrImage(url).toPNG())
      saved(path, mainT('menus.qr.saved'))
      return path
    },
  }
}

function qrImage(url: string): NativeImage {
  const { width, height, data } = qrBitmap(qrMatrix(url), 10)
  return nativeImage.createFromBitmap(Buffer.from(data), { width, height })
}

/**
 * What developer tools act on: the chrome itself when it draws the active
 * tab (apex:// pages, a destination) or when asked for, else the page.
 */
function devtoolsTarget(win: WindowContext, chrome: boolean): WebContents | null {
  if (chrome) return win.chrome.isDestroyed() ? null : win.chrome
  const tab = win.tabs.active()
  if (!tab) return null
  if (win.tabs.isChromeDrawn(tab) || win.tabs.rail() !== null) return win.chrome.isDestroyed() ? null : win.chrome
  return tab.view.webContents.isDestroyed() ? null : tab.view.webContents
}

function openDevtools(wc: WebContents, target: 'page' | 'chrome' | 'console' | 'inspect'): void {
  if (target === 'page' || target === 'chrome') return wc.toggleDevTools()
  const panel = target === 'console' ? 'console' : 'elements'
  const show = (): void => {
    void wc.devToolsWebContents?.executeJavaScript(`window.DevToolsAPI && DevToolsAPI.showPanel(${JSON.stringify(panel)})`).catch(() => undefined)
  }
  if (wc.isDevToolsOpened()) return show()
  wc.once('devtools-opened', () => setTimeout(show, 120))
  wc.openDevTools()
}

/** The page menu's own section (order 90): Inspect, View Source, QR code and Print. */
export function pageToolsMenu(win: WindowContext, actions: PageActions, openQr: (tabId: string) => void) {
  return (params: Electron.ContextMenuParams, tab: Tab): Electron.MenuItemConstructorOptions[] => {
    const wc = tab.view.webContents
    if (wc.isDestroyed() || !isWebUrl(wc.getURL())) return []
    return [
      { label: mainT('menus.pageAction.print'), click: () => actions.print(tab.id) },
      { label: mainT('menus.pageAction.qrCode'), click: () => openQr(tab.id) },
      { label: mainT('menus.pageAction.viewSource'), click: () => actions.viewSource(tab.id) },
      { label: mainT('menus.pageAction.inspect'), click: () => wc.inspectElement(params.x, params.y) },
    ]
  }
}

/** Opens the QR card for a tab at the top of its pane. */
export function openQrCard(win: WindowContext, actions: PageActions, tabId?: string): void {
  const tab = tabId ? win.tabs.find(tabId) : win.tabs.active()
  if (!tab) return
  const url = tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL()
  if (win.tabs.isChromeDrawn(tab) || !isWebUrl(url)) {
    void toasts.show(win, { kind: 'error', text: mainT('menus.qr.notAvailable'), tabId: tab.id })
    return
  }
  let svg: string
  try {
    svg = actions.qrCode(tab.id)
  } catch {
    void toasts.show(win, { kind: 'error', text: mainT('menus.qr.tooLong'), tabId: tab.id })
    return
  }
  const area = areaOf(win, tab.id)
  const opened = openTracked(win, 'qr-code', { kind: 'tab', tabId: tab.id, rect: null }, { url, title: win.tabs.info(tab).title, svg, area }, tab.id)
  opened.result.catch(() => {
    // Before the overlay host is ready there is no card; the address is still one copy away.
    clipboard.writeText(url)
    void toasts.show(win, { kind: 'info', text: mainT('menus.pageAction.linkCopied'), detail: mainT('menus.qr.cardUnavailable'), tabId: tab.id })
  })
}
