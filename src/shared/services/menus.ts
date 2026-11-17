/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Menu services and events: downloads and page actions.
import type { Rect } from '../overlay'
import type { DownloadFolderView } from '../downloads'
import type { MainMenuModel } from '../menuBase'
import type { MenuTarget } from '../menuModel'
import type { DialogEvent, DialogServices } from '../dialogs'

export interface DownloadsServiceAdditions {
  retry(id: string): void
  remove(id: string): void
  /** Keeps a download flagged uncommon or dangerous. */
  keep(id: string): void
  discard(id: string): void
  /** Drags a finished download out of the popover. */
  startDrag(id: string): void
  chooseFolder(): Promise<string | null>
  resetFolder(): void
  /** Where downloads go now, and whether a chosen folder went missing (ST-45). */
  folder(): DownloadFolderView
}

export interface MainMenuServices {
  menus: {
    /** The main-menu popover's model for the focused window (SH-54), contributions applied. */
    mainMenu(): MainMenuModel
    /** Runs a main-menu row by id: a command, a menu action or a dynamic row (tab, page, chat). */
    run(itemId: string): Promise<void>
    /** Windows and Linux: pops one top-level native menu at a point in the chrome (SH-59). */
    popupTop(target: MenuTarget, x: number, y: number): void
  }
}

export interface MenuServices extends DialogServices, MainMenuServices {
  /** Called by the tab menu and the link menu; the tab defaults to the active one. */
  pageActions: {
    copyUrl(tabId?: string): void
    copyMarkdownLink(tabId?: string): void
    copyAsMarkdown(tabId?: string): Promise<void>
    screenshotToClipboard(tabId?: string): Promise<void>
    copyLinkToHighlight(tabId?: string): Promise<void>
    print(tabId?: string): void
    saveAsPdf(tabId?: string): Promise<string | null>
    savePage(tabId?: string): Promise<string | null>
    share(tabId?: string, anchor?: Rect): void
    /** An SVG data URL of the page's QR code. */
    qrCode(tabId?: string): string
    viewSource(tabId?: string): void
    devtools(target: 'page' | 'chrome' | 'console' | 'inspect'): void
    // The QR card's Copy and Save
    copyQrCode(url: string): void
    saveQrCode(url: string): Promise<string | null>
  }
}

export type MenuEvent = { type: 'download-started'; id: string; byAgent: boolean; autoOpen: boolean } | DialogEvent
