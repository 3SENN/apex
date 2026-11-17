/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings services: interface zoom, storage, reset, import,
// the default browser, notifications access, the Dock icon and About.
import type { ExtensionImportReport, ExtensionImportRequest, ImportableExtension, ImportBrowser, ImportProgress, ImportRequest, ImportSummary } from '../browserImport'
import type { ResetResult, ResetStepView, StorageCategoryView } from '../storage'

/** How far back the clear-browsing-data dialog reaches. */
export type ClearRange = 'hour' | 'day' | 'week' | 'month' | 'all'

export interface ClearDataRequest {
  range: ClearRange
  history: boolean
  /** Cookies, local storage, IndexedDB, service workers and site caches. */
  siteData: boolean
  cache: boolean
}

/** One chat's footprint on Settings › Storage (ST-54). */
export interface ChatStorageRow {
  chatId: string
  title: string
  bytes: number
  /** The part that is images (screenshots, pasted pictures). */
  imageBytes: number
  updatedAt: number
}

export interface DefaultBrowserStatus {
  isDefault: boolean
  /** False in a development build (it would register Electron itself) or where the system doesn't allow it. */
  canRegister: boolean
  reason: 'dev-build' | 'unsupported' | null
}

/** Whether the system lets Atelier show notifications; 'unknown' where it can't be read. */
export type SystemNotificationStatus = 'allowed' | 'denied' | 'unknown'

export interface AboutInfo {
  name: string
  version: string
  electron: string
  chromium: string
  node: string
  platform: string
  arch: string
  packaged: boolean
  website: string
  /** Chromium's licences (Electron's LICENSES.chromium.html) as a file URL, or '' when the build has none. */
  chromiumLicenses: string
  /** The system's preferred languages, in order (Settings › Languages, follow the system). */
  systemLanguages: string[]
}

export interface SettingsServices {
  /** The whole interface's scale on chrome-drawn pages, saved app-wide (settings.uiZoom; chat pages use settings.chatZoom). Returns the new scale. */
  uiZoom: {
    step(delta: 1 | -1): number
    reset(): number
  }
  storage: {
    categories(): Promise<StorageCategoryView[]>
    clear(id: string): Promise<void>
    /** Every saved chat with its size, largest first. */
    chats(): Promise<ChatStorageRow[]>
    /** Replaces the images in chats (all, or these) older than `olderThanDays`, keeping the text. Returns how many images went. */
    removeImages(options: { chatIds?: string[]; olderThanDays: number }): Promise<{ removed: number; bytes: number }>
    /** The clear-browsing-data dialog (⇧⌘⌫) and Privacy's two actions. */
    clearBrowsingData(request: ClearDataRequest): Promise<void>
    /** Opens the clear-browsing-data dialog over the current window. */
    openClearDialog(): void
  }
  reset: {
    /** Runs every reset step; `secrets` also deletes the saved key and the password vault. A real run relaunches Atelier into the welcome flow. */
    run(options: { secrets: boolean; dryRun: boolean }): Promise<ResetResult>
    steps(): ResetStepView[]
  }
  browserImport: {
    /** Browsers on this computer with their profiles; Safari is listed with needsAccess until Atelier has Full Disk Access. */
    browsers(): Promise<ImportBrowser[]>
    /** Imports the chosen types; progress arrives as 'import-progress' events. */
    run(request: ImportRequest): Promise<ImportSummary>
    /** macOS: opens System Settings › Privacy & Security › Full Disk Access. */
    openAccessSettings(): void
    /** A Chromium profile's Web Store extensions, marked when this Atelier profile has them. */
    extensions(browserId: string, profileId: string): Promise<ImportableExtension[]>
    /** Adds the picked ones from the Chrome Web Store after one confirmation; reports what was left out. */
    installExtensions(request: ExtensionImportRequest): Promise<ExtensionImportReport>
    /** The Recommended shelf's Add: the store's install prompt, then the install. */
    addRecommended(id: string): Promise<ExtensionImportReport>
  }
  defaultBrowser: {
    status(): DefaultBrowserStatus
    /** Registers Atelier for http and https (macOS asks; Windows opens its default-apps settings). */
    register(): Promise<DefaultBrowserStatus>
  }
  notificationAccess: {
    status(): Promise<SystemNotificationStatus>
    /** Opens the system's notification settings for Atelier. */
    openSystemSettings(): void
    /** Shows a sample notification, so the person can check sounds and banners. */
    test(): void
  }
  /** ST-09; the `dockIcon` namespace is the designed standard icon. */
  dockChoice: {
    /** Takes the rendered Dock image for the chosen companion (macOS); false when the choice changed meanwhile. */
    apply(companionId: string, dataUrl: string): boolean
  }
  about: {
    info(): AboutInfo
  }
}

export type SettingsEvent =
  | { type: 'import-progress'; progress: ImportProgress }
  /** The Dock icon finished re-rendering (Settings › Dock icon shows a spinner until then). */
  | { type: 'dock-icon'; kind: 'standard' | 'companion'; companionId: string | null }
