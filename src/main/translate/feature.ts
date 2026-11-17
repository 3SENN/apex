/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app as electronApp, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { PAGE } from '@shared/ipc'
import type { AppleStatus, PageTranslateBatchReply, TranslateEngineId, TranslateServices } from '@shared/translate'
import type { AppContext, Feature, WindowContext } from '../features/types'
import { languagesFor } from '../languages'
import { log } from '../log'
import { mainLanguage, mainT } from '../i18n/mainT'
import { registerPageMenuSection } from '../pageMenu'
import { appRoot } from '../resources'
import { profileOfWindowId } from '../profiles/windowProfiles'
import { TranslateController, type TranslatePrefs } from './controller'
import { appleEngine, companionEngine, fakeEngine, type TranslateEngine } from './engines'
import { TranslateHelper, translateHelperPath } from './helper'
import { pageBatchSchema, pageHintsSchema, pageReportSchema } from './schemas'

// Page translation, main side (TR-01 to TR-12). The page preload reports its
// language hints on PAGE.translateHints; the controller decides what the pill
// shows (TabInfo.translate, through a tab decorator), and while a page is
// translated it answers PAGE.translateBatch with Apple's on-device engine or,
// when you turned it on, the companion's. Only a tab's main frame is heard.
// Smoke runs a fake engine and never starts the helper or a model.

/** Language & Region in System Settings, where Apple's translation languages are downloaded. */
const LANGUAGE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Localization-Settings.extension'

/** A language's name in Apex's own language ('fr' → French, or Frans in Dutch). */
function languageLabel(tag: string): string {
  try {
    return new Intl.DisplayNames([mainLanguage().locale, 'en'], { type: 'language' }).of(tag) ?? tag
  } catch {
    return tag
  }
}

export interface TranslateSmokeHooks {
  controller: TranslateController
  /** What the fake Apple engine says about every pair. */
  setAppleStatus(status: AppleStatus): void
  /** The batches the fake engines were sent, oldest first. */
  calls(): string[][]
}

let smokeHooks: TranslateSmokeHooks | null = null
let unregisterMenu: (() => void) | null = null
/** Smoke only: the running controller and its fakes. */
export function translateSmokeHooks(): TranslateSmokeHooks | null {
  return smokeHooks
}

export function createTranslateFeature(): Feature {
  let ctx: AppContext | null = null
  let controller: TranslateController | null = null
  let helper: TranslateHelper | null = null
  const stops: (() => void)[] = []

  const windowOfTab = (tabId: string): WindowContext | null => {
    const id = ctx?.tabsRegistry.windowOf(tabId)
    return id === undefined ? null : (ctx?.windows.all().find((w) => w.id === id) ?? null)
  }
  const profileOfTab = (tabId: string): string => profileOfWindowId(windowOfTab(tabId)?.id)

  const prefs = (tabId: string): TranslatePrefs => {
    const settings = ctx!.settings.getFor(profileOfTab(tabId))
    return { settings: settings.translate, languages: languagesFor(settings) }
  }

  /** A tab's own page, main frame only. */
  const tabOf = (event: IpcMainEvent | IpcMainInvokeEvent): string | null => {
    if (!ctx || event.senderFrame !== event.sender.mainFrame) return null
    return ctx.tabsRegistry.byWebContents(event.sender.id)?.id ?? null
  }

  const onHints = (event: IpcMainEvent, raw: unknown): void => {
    const tabId = tabOf(event)
    const parsed = pageHintsSchema.safeParse(raw)
    if (!tabId || !parsed.success || !controller) return
    void controller.hints(tabId, event.sender.getURL(), parsed.data).catch((err: unknown) => log.debug('translate', 'Reading the page language failed', { error: err instanceof Error ? err.message : String(err) }))
  }

  const onBatch = async (event: IpcMainInvokeEvent, raw: unknown): Promise<PageTranslateBatchReply> => {
    const tabId = tabOf(event)
    const parsed = pageBatchSchema.safeParse(raw)
    if (!tabId || !parsed.success || !controller) return { error: 'failed' }
    return controller.batch(tabId, parsed.data.session, parsed.data.texts)
  }

  const onReport = (event: IpcMainEvent, raw: unknown): void => {
    const tabId = tabOf(event)
    const parsed = pageReportSchema.safeParse(raw)
    if (tabId && parsed.success) controller?.report(tabId, parsed.data)
  }

  const services = (): TranslateServices['translate'] => ({
    translate: (tabId, target) => controller?.translate(tabId, target) ?? Promise.resolve(),
    restore: (tabId) => controller?.restore(tabId),
    setAlways: (tabId, on) => controller?.setAlways(tabId, on),
    setNeverSite: (tabId, on) => controller?.setNeverSite(tabId, on),
    setNeverLanguage: (tabId, on) => controller?.setNeverLanguage(tabId, on),
    openLanguageDownloads: () => {
      if (ctx?.smoke || process.platform !== 'darwin') return
      void shell.openExternal(LANGUAGE_SETTINGS_URL).catch(() => undefined)
    },
  })

  return {
    name: 'translate',
    app(app) {
      ctx = app
      let appleStatus: AppleStatus = 'installed'
      const fakes = { apple: fakeEngine('apple'), companion: fakeEngine('companion') }
      let engines: Record<TranslateEngineId, TranslateEngine>
      if (app.smoke) {
        engines = fakes
      } else {
        helper = new TranslateHelper({ path: () => translateHelperPath({ packaged: electronApp.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot() }) })
        engines = { apple: appleEngine(helper), companion: companionEngine(() => app.quick ?? null) }
      }
      controller = new TranslateController({
        prefs,
        savePrefs: (tabId, next) => {
          try {
            app.settings.updateFor(profileOfTab(tabId), { translate: next })
          } catch (err) {
            log.warn('translate', 'Could not save a translation choice', { error: err instanceof Error ? err.message : String(err) })
          }
        },
        appleStatus: (source, target) => (helper ? helper.status(source, target) : Promise.resolve(appleStatus)),
        detect: helper ? (text) => helper!.detect(text) : undefined,
        engine: (id) => engines[id],
        command: (tabId, cmd) => {
          const wc = app.tabsRegistry.get(tabId)?.view.webContents
          if (wc && !wc.isDestroyed()) wc.send(PAGE.translate, cmd)
        },
        changed: (tabId) => windowOfTab(tabId)?.tabs.refresh(),
      })
      if (app.smoke) {
        const c = controller
        smokeHooks = {
          controller: c,
          setAppleStatus: (status) => {
            appleStatus = status
          },
          calls: () => [...fakes.apple.calls, ...fakes.companion.calls],
        }
      }
      // TR-13: the page menu's Translate to <language> or Show original (plain page clicks only).
      // A second start (tests build the features more than once) replaces the first one's wiring.
      unregisterMenu?.()
      ipcMain.removeHandler(PAGE.translateBatch)
      ipcMain.off(PAGE.translateHints, onHints)
      ipcMain.off(PAGE.translateReport, onReport)
      unregisterMenu = registerPageMenuSection({
        id: 'translate',
        order: 35,
        build: (params, tab) => {
          if (params.isEditable || params.linkURL || params.srcURL || params.selectionText) return []
          const entry = controller?.menu(tab.id) ?? null
          if (!entry) return []
          if (entry.kind === 'restore') return [{ label: mainT('translate.menu.showOriginal'), click: () => controller?.restore(tab.id) }]
          return [{ label: mainT('translate.menu.translate', { language: languageLabel(entry.target) }), click: () => void controller?.translate(tab.id) }]
        },
      })
      stops.push(() => {
        unregisterMenu?.()
        unregisterMenu = null
      })
      ipcMain.on(PAGE.translateHints, onHints)
      ipcMain.on(PAGE.translateReport, onReport)
      ipcMain.handle(PAGE.translateBatch, onBatch)
      const onSettings = (next: { translate: unknown; languages: unknown }, previous: { translate: unknown; languages: unknown }): void => {
        if (next.translate !== previous.translate || next.languages !== previous.languages) controller?.settingsChanged()
      }
      const onProfile = (_id: string, next: { translate: unknown; languages: unknown }, previous: { translate: unknown; languages: unknown }): void => onSettings(next, previous)
      app.settings.on('changed', onSettings)
      app.settings.on('profileChanged', onProfile)
      stops.push(
        () => ipcMain.off(PAGE.translateHints, onHints),
        () => ipcMain.off(PAGE.translateReport, onReport),
        () => ipcMain.removeHandler(PAGE.translateBatch),
        () => app.settings.off('changed', onSettings),
        () => app.settings.off('profileChanged', onProfile),
      )
      return { translate: services() }
    },
    window(win) {
      win.tabs.decorate((tab) => ({ translate: controller?.info(tab.id) ?? null }))
      win.tabs.on('navigated', (tab, nav) => {
        if (nav.mainFrame && !nav.inPage) controller?.navigated(tab.id, nav.url)
      })
      win.tabs.on('view-replaced', (tab) => {
        const wc = tab.view.webContents
        controller?.navigated(tab.id, wc.isDestroyed() ? '' : wc.getURL())
      })
      win.tabs.on('closed', (tab, info) => {
        if (!info?.moved) controller?.closed(tab.id)
      })
    },
    dispose() {
      for (const stop of stops.splice(0)) stop()
      helper?.dispose()
      helper = null
      smokeHooks = null
    },
  }
}
