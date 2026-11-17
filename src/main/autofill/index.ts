/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { ipcMain, webFrameMain, type IpcMainEvent, type NativeImage, type WebContents, type WebFrameMain } from 'electron'
import { PAGE_AUTOFILL, type AutofillServices, type AutofillSettings, type MainCommand } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'
import { isBlankUrl } from '@shared/url'
import { toasts } from '../dialogs'
import type { AppContext, WindowContext } from '../features/types'
import type { Authenticator, CaptureMasker, VaultApi, Wallet } from '../features/personalRuntime'
import { log } from '../log'
import { sites } from '../sites'
import type { Tab } from '../tabs'
import { setAgentGuardHooks } from './agentGuard'
import { AutofillController, type PopupRegistry, type TabPort } from './controller'
import { stepAsideForPasswordExtension } from './offers'
import type { FrameHandle } from './frames'
import { applyMask, blankLike, isSecretPage, resizeToEdge } from './masker'
import { overlayPresenter, type Presenter } from './presenter'
import { parseFrameReport } from './reportSchema'
import { GENERATED_ROW, generatePassword } from './rows'

// The autofill domain's entry point: routes PAGE_AUTOFILL
// reports from every frame of every tab to that tab's controller, serves the
// autofill service the overlay surfaces call, and owns the CaptureMasker that
// agent screenshots and voice captures go through.

export interface AutofillSetup {
  masker: CaptureMasker
  services: AutofillServices
  /** Feature.window: the window-wide events popups close on. */
  window(win: WindowContext): void
  /** Feature.tab: the tab's controller; the returned function runs when the tab closes. */
  tab(tab: Tab, win: WindowContext): () => void
  dispose(): void
}

interface Entry {
  controller: AutofillController
  tab: Tab
  win: WindowContext
  wasControlled: boolean
}

/** Smoke-only seams: record surfaces instead of drawing them, and reach the service. */
export const autofillSmoke = {
  presenter: null as ((win: WindowContext, tabId: string) => Presenter) | null,
  services: null as AutofillServices['autofill'] | null,
  controller: null as ((tabId: string) => AutofillController | null) | null,
  /** Smoke only: forget that this session already showed the one-time import hint. */
  resetImportHint: null as (() => void) | null,
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** A WebFrameMain as the controller sees it. Reads are guarded: a frame can be disposed at any time. */
export function frameHandle(frame: WebFrameMain): FrameHandle {
  const alive = (): boolean => safe(() => !frame.isDestroyed() && !frame.detached, false)
  return {
    token: safe(() => frame.frameToken, ''),
    origin: safe(() => frame.origin, ''),
    url: safe(() => frame.url, ''),
    isMain: safe(() => frame.parent === null, false),
    parent: () => {
      const parent = safe(() => frame.parent, null)
      return parent ? frameHandle(parent) : null
    },
    alive,
    send: (command: MainCommand) => {
      if (!alive()) return
      try {
        frame.send(PAGE_AUTOFILL.command, command)
      } catch {
        // The frame went away between the check and the send.
      }
    },
  }
}

function tabPort(tab: Tab, win: WindowContext): TabPort {
  const wc = tab.view.webContents
  return {
    id: tab.id,
    windowId: win.id,
    url: () => safe(() => wc.getURL(), ''),
    agentControlled: () => tab.agentControlled,
    favicon: () => tab.favicon,
    zoom: () => safe(() => wc.getZoomFactor(), 1) || 1,
    chromeZoom: () => safe(() => win.chrome.getZoomFactor(), 1) || 1,
    viewport: () => {
      const b = tab.view.getBounds()
      return { width: b.width, height: b.height }
    },
    certificateException: () => sites.hasCertificateException(tab.id),
    modalOpen: () => safe(() => win.overlay.openSurfaces().some((s) => s.layer === 'modal'), false),
    appInView: () => win.window.isFocused() && win.window.isVisible() && !win.window.isMinimized(),
    topFrame: () => frameHandle(wc.mainFrame),
    frames: () => (wc.isDestroyed() ? [] : wc.mainFrame.framesInSubtree.map(frameHandle)),
  }
}

/**
 * A page capture, tried again a couple of times: the compositor can refuse one
 * for a moment (a tab that only just became visible, a busy GPU process).
 */
async function capturePageRetrying(wc: WebContents, attempts = 3): Promise<NativeImage> {
  for (let i = 1; ; i++) {
    try {
      return await wc.capturePage()
    } catch (err) {
      if (i >= attempts || wc.isDestroyed()) throw err
      await new Promise((r) => setTimeout(r, 150 * i))
    }
  }
}

export function setupAutofill(ctx: AppContext, deps: { vault: VaultApi; wallet: Wallet; auth: Authenticator }): AutofillSetup {
  const entries = new Map<number, Entry>() // by webContents id
  const byTab = new Map<string, Entry>()
  const popups = new Map<string, AutofillController>()
  const offers = new Map<string, AutofillController>()
  let hintShown = false

  const settings = (): AutofillSettings => ctx.settings.get().autofill
  const updateSettings = (patch: Partial<AutofillSettings>): void => {
    ctx.settings.update({ autofill: patch })
  }

  const registry: PopupRegistry = {
    // One fill popup and one card per window: a new one replaces the old.
    popupOpened(owner, id) {
      for (const c of [...popups.values()]) if (c !== owner && c.windowId === owner.windowId) c.closePopup()
      popups.set(id, owner)
    },
    popupClosed: (id) => popups.delete(id),
    offerOpened(owner, id) {
      for (const c of [...offers.values()]) if (c !== owner && c.windowId === owner.windowId) c.closeOffer()
      offers.set(id, owner)
    },
    offerClosed: (id) => offers.delete(id),
  }

  const onReport = (event: IpcMainEvent, raw: unknown): void => {
    // Only tab pages report; the chrome, overlays and floats are never in this map.
    const entry = entries.get(event.sender.id)
    const frame = event.senderFrame
    if (!entry || !frame) return
    const report = parseFrameReport(raw)
    if (!report) return
    entry.controller.onReport(frameHandle(frame), report)
  }
  ipcMain.on(PAGE_AUTOFILL.report, onReport)

  const viewSize = (tab: Tab): { width: number; height: number } => {
    const b = tab.view.getBounds()
    return { width: b.width, height: b.height }
  }

  const guardedArea = async (entry: Entry): Promise<{ rects: Bounds[]; unresolved: boolean }> => {
    try {
      return await entry.controller.guardedRects()
    } catch {
      return { rects: [], unresolved: true }
    }
  }

  const masker: CaptureMasker = {
    async guardedRects(tabId) {
      const entry = byTab.get(tabId)
      if (!entry) return []
      const area = await guardedArea(entry)
      const view = viewSize(entry.tab)
      return area.unresolved ? [{ x: 0, y: 0, width: view.width, height: view.height }] : area.rects
    },
    async capture(tabId, opts) {
      const entry = byTab.get(tabId)
      if (!entry) throw new Error('That tab is closed.')
      const { tab, win } = entry
      const view = viewSize(tab)
      if (isSecretPage(tab.internalUrl)) return resizeToEdge(blankLike(view), opts?.maxEdge)
      const wc = tab.view.webContents
      if (tab.internalUrl || isBlankUrl(wc.getURL())) {
        // Apex draws these in the chrome, so its content area is captured; no page fields there.
        const bounds = win.tabs.contentBounds()
        const zoom = win.chrome.getZoomFactor() || 1
        const image = await win.chrome.capturePage({ x: Math.round(bounds.x / zoom), y: Math.round(bounds.y / zoom), width: Math.round(bounds.width / zoom), height: Math.round(bounds.height / zoom) })
        return resizeToEdge(image, opts?.maxEdge)
      }
      const [area, image] = await Promise.all([guardedArea(entry), capturePageRetrying(wc)])
      if (image.isEmpty()) throw new Error('Could not capture the page.')
      return resizeToEdge(applyMask(image, area, view), opts?.maxEdge)
    },
  }

  setAgentGuardHooks({
    focusedGuard: async (tabId) => (await byTab.get(tabId)?.controller.focusedGuard()) ?? null,
    mask: async (tabId, image: NativeImage, region) => {
      const entry = byTab.get(tabId)
      if (!entry) return image
      return applyMask(image, await guardedArea(entry), viewSize(entry.tab), region)
    },
    // Only the fields placed for sure: an unplaced frame masks a whole capture, but mustn't refuse every field.
    guardedRects: async (tabId) => {
      const entry = byTab.get(tabId)
      return entry ? (await guardedArea(entry)).rects : []
    },
  })

  const services: AutofillServices['autofill'] = {
    pick: async (popupId, itemId) => (await popups.get(popupId)?.pick(popupId, itemId)) ?? 'gone',
    useGenerated: async (popupId) => {
      const result = (await popups.get(popupId)?.pick(popupId, GENERATED_ROW)) ?? 'gone'
      if (result !== 'filled') throw new Error(result === 'too-soon' ? 'The suggestion just appeared. Try again in a moment.' : 'That suggestion is gone.')
    },
    dismiss: (popupId) => popups.get(popupId)?.dismissPopup(popupId),
    surfaceShown: (popupId, rect) => popups.get(popupId)?.surfaceShown(popupId, rect),
    respondOffer: async (offerId, action, edited) => {
      await offers.get(offerId)?.respondOffer(offerId, action, edited)
    },
    dismissImportHint: () => {
      updateSettings({ importHintDismissed: true })
      for (const entry of entries.values()) entry.controller.closeImportHint()
    },
  }

  autofillSmoke.services = services
  autofillSmoke.controller = (tabId) => byTab.get(tabId)?.controller ?? null
  autofillSmoke.resetImportHint = () => {
    hintShown = false
  }

  const inWindow = (win: WindowContext): Entry[] => [...entries.values()].filter((e) => e.win.id === win.id)

  return {
    masker,
    services: { autofill: services },
    window(win) {
      const { tabs, window } = win
      tabs.on('navigated', (tab, nav) => byTab.get(tab.id)?.controller.onNavigated(nav))
      tabs.on('activated', (tab) => {
        for (const e of inWindow(win)) if (e.tab.id !== tab.id) e.controller.closePopup()
      })
      tabs.on('zoom-changed', (tab) => byTab.get(tab.id)?.controller.closePopup())
      tabs.on('changed', () => {
        const hidden = tabs.isHidden()
        for (const e of inWindow(win)) {
          // The agent taking a tab over withdraws its popup and its offer.
          if (e.tab.agentControlled && !e.wasControlled) e.controller.onAgentControl()
          e.wasControlled = e.tab.agentControlled
          if (hidden) e.controller.closePopup()
        }
      })
      const closeAll = (): void => {
        for (const e of inWindow(win)) e.controller.closePopup()
      }
      window.on('hide', closeAll)
      window.on('minimize', closeAll)
      window.on('resize', closeAll)
    },
    tab(tab, win) {
      const wc: WebContents = tab.view.webContents
      // A password extension in this tab's profile (Apple Passwords) takes over password offers; addresses and cards stay.
      const heldBy = (): string | null => {
        const page = tab.view.webContents
        if (page.isDestroyed()) return null
        return safe(() => ctx.content.extensions.passwordSavingHeldOff?.(ctx.content.profiles.profileOf(page))?.name ?? null, null)
      }
      const tabSettings = (): AutofillSettings => stepAsideForPasswordExtension(settings(), heldBy())
      const controller = new AutofillController({
        tab: tabPort(tab, win),
        vault: () => deps.vault,
        wallet: () => deps.wallet,
        auth: () => deps.auth,
        settings: tabSettings,
        updateSettings,
        // Looked up per open, so smoke can swap in a recorder after tabs exist.
        presenter: { open: (surface, rect, props, id) => (autofillSmoke.presenter?.(win, tab.id) ?? overlayPresenter(win, tab.id)).open(surface, rect, props, id) },
        registry,
        notify: (n) => ctx.notify(n),
        toast: (spec) => toasts.show(win, spec),
        openUrl: (url) => win.tabs.openInternal(url, { newTab: true }),
        importHint: {
          shouldShow: () => !hintShown && !settings().passwordsImported && !settings().importHintDismissed,
          markShown: () => {
            hintShown = true
          },
        },
        generatePassword: () => generatePassword(),
        now: Date.now,
        ids: randomUUID,
      })
      const entry: Entry = { controller, tab, win, wasControlled: tab.agentControlled }
      entries.set(wc.id, entry)
      byTab.set(tab.id, entry)

      const onFrameNavigate = (_e: unknown, _url: string, _code: number, _status: string, isMainFrame: boolean, processId: number, routingId: number): void => {
        if (isMainFrame) return
        const frame = safe(() => webFrameMain.fromId(processId, routingId), undefined)
        if (frame) controller.onNavigated({ mainFrame: false, inPage: false, frameToken: safe(() => frame.frameToken, '') })
      }
      const onStartNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
        if (details.isMainFrame && !details.isSameDocument) controller.closePopup()
      }
      const onZoom = (): void => controller.closePopup()
      wc.on('did-frame-navigate', onFrameNavigate)
      wc.on('did-start-navigation', onStartNavigation)
      wc.on('zoom-changed', onZoom)
      return () => {
        controller.dispose()
        entries.delete(wc.id)
        byTab.delete(tab.id)
        if (!wc.isDestroyed()) {
          wc.off('did-frame-navigate', onFrameNavigate)
          wc.off('did-start-navigation', onStartNavigation)
          wc.off('zoom-changed', onZoom)
        }
      }
    },
    dispose() {
      ipcMain.removeListener(PAGE_AUTOFILL.report, onReport)
      setAgentGuardHooks(null)
      for (const entry of entries.values()) entry.controller.dispose()
      entries.clear()
      byTab.clear()
      autofillSmoke.services = null
      autofillSmoke.controller = null
      log.debug('autofill', 'stopped')
    },
  }
}
