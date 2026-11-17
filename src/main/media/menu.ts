/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clipboard, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import { MEDIA_RATES, PAGE_MEDIA, nearestRate, rateLabel, type PageMediaCommand } from '@shared/media'
import { currentLocale } from '@shared/i18n/core'
import { mainT } from '../i18n/mainT'
import { registerPageMenuSection } from '../pageMenu'
import { PIP_WORLD } from '../pip'
import type { WindowContext } from '../features/types'
import type { Tab } from '../tabs'
import { TOGGLE_PIP_SCRIPT, pipAtPointScript } from './hub'
import { mediaReportOf } from './registry'

// The page menu on a video or audio element (MD-03): playback speed, loop,
// show controls and picture-in-picture, then open, save and copy its address.
// Electron's menu has none of these, so the
// frame's page helper acts on the element the menu opened on; picture-in-
// picture needs a user gesture, so in the main frame it runs from Apex's own
// world at the menu's point.

function sendTo(params: ContextMenuParams, command: PageMediaCommand): void {
  const frame = params.frame
  if (frame && !frame.isDestroyed()) frame.send(PAGE_MEDIA.command, command)
}

async function togglePip(params: ContextMenuParams, tab: Tab): Promise<void> {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return
  const frame = params.frame
  const main = wc.mainFrame
  if (frame && !frame.isDestroyed() && (frame.processId !== main.processId || frame.routingId !== main.routingId)) {
    await frame.executeJavaScript(TOGGLE_PIP_SCRIPT, true).catch(() => false)
    return
  }
  const zoom = wc.getZoomFactor() || 1
  await wc.executeJavaScriptInIsolatedWorld(PIP_WORLD, [{ code: pipAtPointScript(Math.round(params.x / zoom), Math.round(params.y / zoom)) }], true).catch(() => false)
}

export function mediaMenuItems(params: ContextMenuParams, tab: Tab, win: WindowContext): MenuItemConstructorOptions[] {
  if (params.mediaType !== 'video' && params.mediaType !== 'audio') return []
  const video = params.mediaType === 'video'
  const f = params.mediaFlags
  const current = nearestRate(mediaReportOf(tab.id)?.rate ?? 1)
  const locale = currentLocale()
  const items: MenuItemConstructorOptions[] = [
    {
      label: mainT('media.menu.speed'),
      enabled: !f.inError,
      submenu: MEDIA_RATES.map((rate) => ({
        label: rate === 1 ? mainT('media.speed.normal') : rateLabel(rate, locale),
        type: 'radio' as const,
        checked: rate === current,
        click: () => sendTo(params, { kind: 'context', op: 'rate', rate }),
      })),
    },
    { label: mainT('media.menu.loop'), type: 'checkbox', checked: f.isLooping, enabled: !f.inError, click: () => sendTo(params, { kind: 'context', op: 'loop' }) },
    { label: mainT('media.menu.controls'), type: 'checkbox', checked: f.isControlsVisible, enabled: f.canToggleControls, click: () => sendTo(params, { kind: 'context', op: 'controls' }) },
  ]
  if (video) {
    items.push({ label: mainT('media.menu.pip'), type: 'checkbox', checked: f.isShowingPictureInPicture, enabled: f.canShowPictureInPicture || f.isShowingPictureInPicture, click: () => void togglePip(params, tab) })
  }
  const src = params.srcURL
  if (/^https?:/i.test(src)) {
    items.push(
      { type: 'separator' },
      { label: mainT(video ? 'media.menu.openVideo' : 'media.menu.openAudio'), click: () => void win.tabs.create(src, { activate: false, afterId: tab.id }) },
      { label: mainT(video ? 'media.menu.saveVideo' : 'media.menu.saveAudio'), enabled: f.canSave, click: () => tab.view.webContents.isDestroyed() || tab.view.webContents.downloadURL(src) },
      { label: mainT(video ? 'media.menu.copyVideo' : 'media.menu.copyAudio'), click: () => clipboard.writeText(src) },
    )
  }
  return items
}

/** Registers the section after the links and images (10), before back and forward (15). */
export function registerMediaMenu(): () => void {
  return registerPageMenuSection({ id: 'media', order: 12, build: (params, tab, win) => mediaMenuItems(params, tab, win) })
}
