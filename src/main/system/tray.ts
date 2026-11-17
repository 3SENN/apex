/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Menu, Tray, nativeImage, nativeTheme, type MenuItemConstructorOptions } from 'electron'
import type { MenuItemModel } from '@shared/menuModel'
import type { OsPlatform } from '@shared/system'
import type { MessageKey, MessageVars } from '../i18n/mainT'
import { resourcePath } from '../resources'

// The tray: the menu-bar extra on macOS, the notification-area
// icon on Windows and the AppIndicator on Linux. trayMenuItems is pure (the
// system:tray menu contribution builds with it); TrayIcon owns the native
// icon and renders whatever the 'tray' target's contributions return.

export interface TrayStatus {
  recording: 'none' | 'recording' | 'paused'
  /** The soonest enabled routine run, epoch ms. */
  nextRunAt: number | null
  needsYou: number
  /** An update is downloaded and waits for a restart. */
  updateReady: boolean
}

export const TRAY_IDS = {
  open: 'tray:open',
  newWindow: 'tray:new-window',
  newChat: 'tray:new-chat',
  needsYou: 'tray:needs-you',
  status: 'tray:status',
  stopRecording: 'tray:stop-recording',
  update: 'tray:update',
  quit: 'tray:quit',
} as const

export type TrayAction = (typeof TRAY_IDS)[keyof typeof TRAY_IDS]

type Translate = (key: MessageKey, vars?: MessageVars) => string

export interface TimeFormat {
  time(at: number): string
  date(at: number): string
}

const defaultFormat: TimeFormat = {
  time: (at) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  date: (at) => new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
}

function dayStart(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The routine half of the status line, by calendar day in local time. */
export function nextRunLabel(at: number | null, now: number, t: Translate, fmt: TimeFormat = defaultFormat): string {
  if (at === null) return t('system.tray.noRoutines')
  if (at - now < 60_000) return t('system.tray.nextRun.due')
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000)
  if (days <= 0) return t('system.tray.nextRun.today', { time: fmt.time(at) })
  if (days === 1) return t('system.tray.nextRun.tomorrow', { time: fmt.time(at) })
  return t('system.tray.nextRun.later', { date: fmt.date(at), time: fmt.time(at) })
}

/** The tray menu: open and create, what is going on (a recording wins over routines), then Quit. */
export function trayMenuItems(status: TrayStatus, now: number, t: Translate, fmt?: TimeFormat): MenuItemModel[] {
  const items: MenuItemModel[] = [
    { id: TRAY_IDS.open, label: t('system.tray.open') },
    { id: TRAY_IDS.newWindow, label: t('system.tray.newWindow'), commandId: 'new-window' },
    { id: TRAY_IDS.newChat, label: t('system.tray.newChat'), commandId: 'new-chat' },
    { id: 'tray:sep-status', label: '', type: 'separator' },
  ]
  if (status.needsYou > 0) items.push({ id: TRAY_IDS.needsYou, label: t('system.tray.needsYou', { count: status.needsYou }) })
  if (status.recording !== 'none') {
    items.push({ id: TRAY_IDS.status, label: t(status.recording === 'paused' ? 'system.tray.recordingPaused' : 'system.tray.recording'), enabled: false })
    items.push({ id: TRAY_IDS.stopRecording, label: t('system.tray.stopRecording') })
  } else {
    items.push({ id: TRAY_IDS.status, label: nextRunLabel(status.nextRunAt, now, t, fmt), enabled: false })
  }
  items.push({ id: 'tray:sep-quit', label: '', type: 'separator' })
  if (status.updateReady) items.push({ id: TRAY_IDS.update, label: t('system.tray.restartToUpdate') })
  items.push({ id: TRAY_IDS.quit, label: t('system.tray.quit'), commandId: 'quit' })
  return items
}

/** The tray image for a platform; Windows follows the taskbar's own light or dark. */
export function trayImageFile(platform: OsPlatform, darkTaskbar: boolean): string {
  if (platform === 'darwin') return 'trayTemplate.png'
  if (platform === 'win32') return darkTaskbar ? 'tray-dark.ico' : 'tray-light.ico'
  return 'tray.png'
}

/** MenuItemModel to Electron's template; clicks report the item's id. */
export function trayTemplate(items: readonly MenuItemModel[], pick: (item: MenuItemModel) => void): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    return {
      id: item.id,
      label: item.label,
      type: item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal',
      enabled: item.enabled ?? true,
      checked: item.checked,
      ...(item.submenu ? { submenu: trayTemplate(item.submenu, pick) } : { click: () => pick(item) }),
    }
  })
}

/** The native icon. Created while background mode is on; destroyed when it goes off. */
export class TrayIcon {
  #tray: Tray | null = null
  readonly #platform: OsPlatform
  readonly #onClick: () => void
  readonly #retheme = (): void => this.#applyImage()

  constructor(o: { platform: OsPlatform; onClick(): void }) {
    this.#platform = o.platform
    this.#onClick = o.onClick
  }

  get shown(): boolean {
    return this.#tray !== null && !this.#tray.isDestroyed()
  }

  show(): void {
    if (this.shown) return
    this.#tray = new Tray(this.#image())
    // Windows and Linux open Apex on a click; macOS shows the menu, as menu-bar extras do.
    if (this.#platform !== 'darwin') this.#tray.on('click', () => this.#onClick())
    if (this.#platform === 'win32') nativeTheme.on('updated', this.#retheme)
  }

  hide(): void {
    nativeTheme.off('updated', this.#retheme)
    if (this.#tray && !this.#tray.isDestroyed()) this.#tray.destroy()
    this.#tray = null
  }

  render(items: readonly MenuItemModel[], tooltip: string, pick: (item: MenuItemModel) => void): void {
    const tray = this.#tray
    if (!tray || tray.isDestroyed()) return
    tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(items, pick)))
    tray.setToolTip(tooltip)
  }

  #image(): Electron.NativeImage {
    const dark = this.#platform === 'win32' && (nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors)
    const image = nativeImage.createFromPath(resourcePath('tray', trayImageFile(this.#platform, dark)))
    // The macOS menu bar tints a template image for light, dark and highlighted states.
    if (this.#platform === 'darwin') image.setTemplateImage(true)
    return image
  }

  #applyImage(): void {
    if (this.#tray && !this.#tray.isDestroyed()) this.#tray.setImage(this.#image())
  }
}
