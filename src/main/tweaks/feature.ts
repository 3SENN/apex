/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app as electronApp, dialog, ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import {
  TWEAK_LIMITS,
  tweakBlock,
  tweakCovers,
  tweakHostAllowed,
  pageTweakHost,
  rulesFor,
  type TweakTabInfo,
  type TweaksServices,
  type PageTweakPush,
  type PageTweakRules,
  type PickerStrings,
} from '@shared/tweaks'
import { PAGE } from '@shared/ipc'
import type { AppContext, Feature, ServiceParts } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'
import type { Tab } from '../tabs'
import { exportTweaks, exportName, parseTweakExport } from './io'
import { pageTweakMessage } from './schemas'
import { LEGACY_TWEAKS_FILE, TWEAKS_FILE, TweakError, TweakStore } from './store'

// Tweaks in main (TWK-01 to TWK-06): the store, the page protocol and the
// services. Each top frame's preload asks for its rules at document start
// (PAGE.tweaks 'get', sendSync); main answers only a tab's main frame, and
// nothing on sign-in or atelier:// pages. When a tweak changes, every open tab
// whose rules changed gets them again (PAGE.tweaksPush 'rules'), so CSS
// changes show at once; a script runs again on the next load. Hidden elements
// are taken only from a tab main asked to pick (hideElements()), for the host
// main sees there, never the one a page claims.

type Ns = TweaksServices['tweaks']

const EMPTY: PageTweakRules = { generated: '', custom: '', scripts: [] }

let current: TweakStore | null = null
let pickInTab: ((tabId: string) => boolean) | null = null
// Packs' tweaks (docs/packs.md): CSS and scripts from enabled packs, added after your own tweaks' rules.
let packRules: ((url: string, isPrivate: boolean) => PageTweakRules | null) | null = null
let refresh: (() => void) | null = null

/** Sets where packs' tweak rules come from and pushes them to open tabs; null removes them. */
export function setPackTweakRules(fn: ((url: string, isPrivate: boolean) => PageTweakRules | null) | null): void {
  packRules = fn
  refresh?.()
}

/** Your tweaks' rules for a page, then the packs' (never in a private window). */
function allRules(state: ReturnType<TweakStore['state']>, url: string, isPrivate = false): PageTweakRules | null {
  const own = rulesFor(state, url)
  const extra = tweakBlock(url) ? null : (packRules?.(url, isPrivate) ?? null)
  if (!extra) return own
  if (!own) return extra
  return {
    generated: [own.generated, extra.generated].filter(Boolean).join('\n'),
    custom: [own.custom, extra.custom].filter(Boolean).join('\n'),
    scripts: [...own.scripts, ...extra.scripts],
  }
}

/** The running store (smoke checks and other main modules); null before start-up. */
export function tweakStore(): TweakStore | null {
  return current
}

/** Starts the picker in a tab, as site info's Hide elements does; false where tweaks can't run. */
export function startPicking(tabId: string): boolean {
  return pickInTab?.(tabId) ?? false
}

export function pickerStrings(count: number): PickerStrings {
  return {
    title: mainT('tweaks.picker.title'),
    hint: mainT('tweaks.picker.hint'),
    keys: mainT('tweaks.picker.keys'),
    undo: mainT('tweaks.picker.undo'),
    done: mainT('tweaks.picker.done'),
    count: mainT('tweaks.picker.count', { count }),
  }
}

/** What a rules push compares: the CSS (a script only runs again on the next load). */
const cssKey = (rules: PageTweakRules | null): string => (rules ? `${rules.generated}\u0000${rules.custom}` : '')

export function createTweaksFeature(): Feature {
  let ctx: AppContext | null = null
  let store: TweakStore | null = null
  const stops: (() => void)[] = []
  /** Tabs picking elements now (by webContents id), with the elements hidden this time, for Undo. */
  const picking = new Map<number, string[]>()
  /** The CSS each tab's current document has, by webContents id. */
  const pushed = new Map<number, string>()

  const send = (wc: WebContents, payload: PageTweakPush): void => {
    try {
      if (!wc.isDestroyed()) wc.mainFrame.send(PAGE.tweaksPush, payload)
    } catch {
      // The frame went away mid-navigation; its next document asks again.
    }
  }

  const urlOf = (tab: Tab): string => {
    const wc = tab.view.webContents
    return wc.isDestroyed() ? tab.requestedUrl : wc.getURL() || tab.requestedUrl
  }

  const refreshTabs = (): void => {
    if (!ctx || !store) return
    const state = store.state()
    for (const tab of ctx.tabsRegistry.all()) {
      const wc = tab.view.webContents
      if (wc.isDestroyed()) continue
      const rules = tab.internalUrl ? null : allRules(state, wc.getURL(), ctx.windows.fromWebContents(wc.id)?.kind === 'private')
      const key = cssKey(rules)
      if ((pushed.get(wc.id) ?? '') === key) continue
      if (key) pushed.set(wc.id, key)
      else pushed.delete(wc.id)
      send(wc, { kind: 'rules', rules: rules ?? EMPTY })
    }
  }

  const countFor = (host: string): number => store?.owning(host)?.hidden.length ?? 0

  const hostToPick = (tab: Tab): string | null => {
    if (tab.internalUrl) return null
    const url = urlOf(tab)
    const host = pageTweakHost(url)
    return host && !tweakBlock(url) && tweakHostAllowed(host) ? host : null
  }

  const onPage = (event: IpcMainEvent, raw: unknown): void => {
    const parsed = pageTweakMessage.safeParse(raw)
    if (!parsed.success) {
      event.returnValue = null
      return
    }
    const message = parsed.data
    const wc = event.sender
    const tab = ctx?.tabsRegistry.byWebContents(wc.id)
    const top = event.senderFrame === wc.mainFrame
    if (message.kind === 'get') {
      // The preload's own address for its document: main's committed URL can trail it at document start.
      const rules = tab && top && store && !tab.sandbox ? allRules(store.state(), message.url, ctx?.windows.fromWebContents(wc.id)?.kind === 'private') : null
      picking.delete(wc.id)
      const key = cssKey(rules)
      if (key) pushed.set(wc.id, key)
      else pushed.delete(wc.id)
      event.returnValue = rules
      return
    }
    if (!tab || !top || !store || !picking.has(wc.id)) return
    const host = hostToPick(tab)
    if (!host) return
    try {
      if (message.kind === 'hide') {
        const { element } = store.addHidden(host, message.selector, message.label)
        picking.get(wc.id)?.push(element.id)
        send(wc, { kind: 'count', count: mainT('tweaks.picker.count', { count: countFor(host) }), announce: mainT('tweaks.picker.hidden', { label: element.label }) })
      } else if (message.kind === 'undo') {
        const last = picking.get(wc.id)?.pop()
        const tweak = store.owning(host)
        if (last && tweak) store.removeHidden(tweak.id, last)
        send(wc, { kind: 'count', count: mainT('tweaks.picker.count', { count: countFor(host) }), announce: last ? mainT('tweaks.picker.restored') : mainT('tweaks.picker.nothingToUndo') })
      } else {
        picking.delete(wc.id)
      }
    } catch (err) {
      const text = err instanceof TweakError ? err.message : mainT('tweaks.error.selector')
      send(wc, { kind: 'count', count: mainT('tweaks.picker.count', { count: countFor(host) }), announce: text })
    }
  }

  const hideElements = (tabId: string): boolean => {
    const tab = ctx?.tabsRegistry.get(tabId)
    if (!tab || !store) return false
    const host = hostToPick(tab)
    const wc = tab.view.webContents
    if (!host || wc.isDestroyed()) return false
    picking.set(wc.id, [])
    send(wc, { kind: 'pick', on: true, strings: pickerStrings(countFor(host)) })
    wc.focus()
    return true
  }

  const forTab = (tabId: string): TweakTabInfo => {
    const scriptsAllowed = store?.state().scriptsAllowed ?? false
    const tab = ctx?.tabsRegistry.get(tabId)
    if (!tab || !store) return { host: null, blocked: 'not-web', tweak: null, scriptsAllowed, picking: false }
    const url = tab.internalUrl ?? urlOf(tab)
    const host = tab.internalUrl ? null : pageTweakHost(url)
    const blocked = tab.internalUrl ? 'internal' : (tweakBlock(url) ?? (host && !tweakHostAllowed(host) ? 'sign-in' : host ? null : 'not-web'))
    const wc = tab.view.webContents
    return { host, blocked, tweak: host ? store.owning(host) : null, scriptsAllowed, picking: !wc.isDestroyed() && picking.has(wc.id) }
  }

  const need = (): TweakStore => {
    if (!store) throw new TweakError(mainT('tweaks.error.missing'))
    return store
  }

  return {
    name: 'tweaks',
    app(app): ServiceParts {
      ctx = app
      const path = join(app.dataDir, TWEAKS_FILE)
      const legacyPath = join(app.dataDir, LEGACY_TWEAKS_FILE)
      store = new TweakStore({ read: () => readJson(path), write: (text) => writeAtomic(path, text), readLegacy: () => (existsSync(path) ? undefined : readJson(legacyPath)) })
      current = store
      pickInTab = hideElements
      refresh = refreshTabs
      const onChanged = (): void => {
        refreshTabs()
        if (store) app.broadcast({ type: 'tweaks', state: store.state() })
      }
      store.on('changed', onChanged)
      ipcMain.on(PAGE.tweaks, onPage)
      stops.push(
        () => store?.off('changed', onChanged),
        () => ipcMain.off(PAGE.tweaks, onPage),
      )
      const tweaks: Partial<Ns> = {
        state: () => need().state(),
        forTab,
        create: (hostOrUrl) => need().create(hostOrUrl),
        update: (id, patch) => need().update(id, patch),
        remove: (id) => need().remove(id),
        restore: (tweak) => need().restore(tweak),
        removeHidden: (id, hiddenId) => need().removeHidden(id, hiddenId),
        clearHidden: (id) => need().clearHidden(id),
        setScriptsAllowed: (on) => need().setScriptsAllowed(on),
        hideElements,
      }
      return { tweaks }
    },
    window(win): ServiceParts {
      const tweaks: Partial<Ns> = {
        openAndHide: (id) => {
          const tweak = need().get(id)
          if (!tweak) throw new TweakError(mainT('tweaks.error.missing'))
          const tab = win.tabs.create(`https://${tweak.host}/`, { activate: true })
          const wc = tab.view.webContents
          // Picking starts once the site's own page is in (not an error page or another site it sent us to).
          wc.once('did-finish-load', () => {
            const host = pageTweakHost(wc.getURL())
            if (host && tweakCovers(tweak, host)) hideElements(tab.id)
          })
        },
        exportFile: async (ids) => {
          const all = need().state().tweaks
          const chosen = ids ? all.filter((b) => ids.includes(b.id)) : all
          const picked = await dialog.showSaveDialog(win.window, {
            defaultPath: join(electronApp.getPath('downloads'), exportName(chosen)),
            filters: [{ name: mainT('tweaks.file.filter'), extensions: ['json'] }],
          })
          if (picked.canceled || !picked.filePath) return null
          writeFileSync(picked.filePath, exportTweaks(chosen), 'utf8')
          return picked.filePath
        },
        importFile: async () => {
          const picked = await dialog.showOpenDialog(win.window, { properties: ['openFile'], filters: [{ name: mainT('tweaks.file.filter'), extensions: ['json'] }] })
          const file = picked.canceled ? null : picked.filePaths[0]
          if (!file) return null
          if (statSync(file).size > TWEAK_LIMITS.importBytes) throw new TweakError(mainT('tweaks.error.tooBig'))
          return need().importTweaks(parseTweakExport(readFileSync(file, 'utf8')))
        },
      }
      return { tweaks }
    },
    tab(tab) {
      const wc = tab.view.webContents
      const id = wc.id
      // A new page ends picking; its preload asks for its rules again.
      const onNavigate = (): void => {
        picking.delete(id)
      }
      wc.on('did-navigate', onNavigate)
      return () => {
        picking.delete(id)
        pushed.delete(id)
        if (!wc.isDestroyed()) wc.off('did-navigate', onNavigate)
      }
    },
    dispose() {
      for (const stop of stops.splice(0)) {
        try {
          stop()
        } catch (err) {
          log.warn('tweaks', 'Stopping tweaks failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      current = null
      pickInTab = null
      refresh = null
    },
  }
}
