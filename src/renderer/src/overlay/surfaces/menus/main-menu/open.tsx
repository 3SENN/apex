/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SettingsView } from '@shared/ipc'
import { menuBarTarget, type MainMenuSurfaceProps } from '@shared/menuBase'
import type { OverlayResult } from '@shared/overlay'
import type { SpendView } from '@shared/pricing'
import { apex, call, errorText } from '../../../../api'
import { toast } from '../../../../ui'
import { openInChrome, pressAnchor } from '../../../kit/chromeHost'
import { anchorFromElement } from '../../../useSurface'
import { mainMenuSurface } from '.'

// Opens the main menu from the sidebar footer's profile row or the toolbar's
// menu button (SH-16, SH-54). It draws in the overlay layer above the page
// when the overlay host is up, and in the chrome until then. A choice runs in main
// (menus.run), except the few rows the chrome itself answers.

export interface MainMenuOpener {
  settings: SettingsView
  /** The footer's live spend, when it has one; asked for otherwise. */
  spend: SpendView | null
  renameWindow(): void
}

let openId: string | null = null
let busy = false
let closedAt = 0

/** Opens the surface in the overlay host and keeps its id, so a second press closes it. Rejects when the host is not up. */
async function openInHost(props: MainMenuSurfaceProps, where: ReturnType<typeof anchorFromElement>): Promise<OverlayResult> {
  const results: OverlayResult[] = []
  let settle: ((r: OverlayResult) => void) | null = null
  // Subscribed before opening, so a result can never arrive unheard.
  const off = apex.overlay.onResult((r) => {
    if (settle && r.instanceId === openId) settle(r)
    else results.push(r)
  })
  try {
    const { instanceId } = await apex.overlay.open('main-menu', where, props)
    openId = instanceId
    const early = results.find((r) => r.instanceId === instanceId)
    if (early) return early
    return await new Promise<OverlayResult>((resolve) => (settle = resolve))
  } finally {
    off()
  }
}

/** Rows the chrome answers itself; the rest run in main. */
export async function runMainMenuChoice(id: string, opener: Pick<MainMenuOpener, 'renameWindow'>, anchor?: HTMLElement): Promise<void> {
  if (id === 'rename-window') return opener.renameWindow()
  if (id === 'add-api-key') return call('pages', 'open', 'apex://settings/model')
  try {
    // Windows and Linux: a Menu bar row pops that top-level native menu beside the opener (SH-59).
    const target = menuBarTarget(id)
    if (target) {
      const r = anchor?.getBoundingClientRect()
      const above = r ? r.top > window.innerHeight / 2 : false
      await call('menus', 'popupTop', target, Math.round(r?.left ?? 0), Math.round(r ? (above ? r.top : r.bottom) : 0))
      return
    }
    await call('menus', 'run', id)
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

export async function openMainMenu(anchor: HTMLElement, opener: MainMenuOpener): Promise<void> {
  // A second press on the anchor closes the menu instead of opening another.
  if (openId) {
    apex.overlay.close(openId)
    return
  }
  // Still fetching the model from an earlier press, or it just closed from this press.
  if (busy || performance.now() - closedAt < 250) return
  busy = true
  try {
    await show(anchor, opener)
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  } finally {
    busy = false
  }
}

async function show(anchor: HTMLElement, opener: MainMenuOpener): Promise<void> {
  const { settings } = opener
  const engine: string = settings.engine
  const [model, spend] = await Promise.all([call('menus', 'mainMenu'), engine === 'api-key' ? (opener.spend ?? call('spend', 'view').catch(() => null)) : Promise.resolve(null)])
  const props: MainMenuSurfaceProps = {
    model,
    profile: { name: settings.userName, avatar: settings.userAvatar, engine, hasApiKey: settings.hasApiKey },
    spend: spend ? { usd: spend.usd, budgetUsd: spend.budgetUsd } : null,
    placement: anchor.getBoundingClientRect().top < window.innerHeight / 2 ? 'below' : 'above',
  }
  const where = anchorFromElement(anchor)
  let result: OverlayResult
  const unpress = pressAnchor(anchor)
  try {
    result = await openInHost(props, where)
  } catch {
    // The overlay host isn't up yet: draw it in the chrome.
    unpress()
    result = await openInChrome(mainMenuSurface, props, where, { anchorEl: anchor })
  } finally {
    unpress()
    openId = null
    closedAt = performance.now()
  }
  if ('value' in result) {
    const value = result.value as { id?: unknown; refocus?: unknown } | null
    if (value && typeof value.id === 'string') await runMainMenuChoice(value.id, opener, anchor)
    else if (value?.refocus === true) anchor.focus({ preventScroll: true })
  } else if (result.dismissed === 'escape') anchor.focus({ preventScroll: true })
}
