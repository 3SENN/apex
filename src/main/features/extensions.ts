/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { app, dialog, webContents as allContents, webFrameMain, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { EXTENSIONS_SETTINGS_URL, WEB_STORE_URL, isExtensionUrl, type ExtensionInfo } from '@shared/extensions'
import { menus, registerMenuContribution, type MenuItemModel } from '@shared/menuModel'
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILE_PARTITION } from '@shared/profiles'
import { dialogs, toasts } from '../dialogs'
import { setupExtensions, type Extensions, type ServiceWindow } from '../extensions/service'
import { hostDirs } from '../extensions/nativeMessaging'
import type { MenuNode, MenuTarget } from '../extensions/contextMenus'
import { frameIdOf, asNavFrame } from '../extensions/webNavigation'
import { registerPageMenuSection } from '../pageMenu'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { permissionPolicy } from '../permissionPolicy'
import { shortcuts } from '../shortcuts'
import type { AppContext, Feature, WindowContext } from './types'

// The extensions feature module: extensions on every persistent profile session
// (Electron refuses them in in-memory sessions), toolbar actions, prompts
// and native messaging. It fills ctx.content.extensions, adds the Extensions menu
// and the main menu's entry (SH-58, SH-54), answers permission requests from
// extension pages, and routes manifest command keys.

const PROFILE_PARTITION = /^persist:apex-profile-([a-z0-9]{8,32})$/

/** The profile a persistent partition belongs to, or null for any other session. */
export function profileOfPartition(partition: string): string | null {
  if (partition === DEFAULT_PROFILE_PARTITION) return DEFAULT_PROFILE_ID
  return PROFILE_PARTITION.exec(partition)?.[1] ?? null
}

/** Web permissions an extension page may use when its manifest declares the matching permission. */
const PAGE_PERMISSIONS: Record<string, string | null> = {
  'clipboard-read': 'clipboardRead',
  'clipboard-sanitized-write': null,
  notifications: 'notifications',
  geolocation: 'geolocation',
  fullscreen: null,
  'persistent-storage': null,
}

export function createExtensionsFeature(): Feature {
  let extensions: Extensions | null = null
  let ctx: AppContext | null = null
  const cleanups: Array<() => void> = []

  const profileOf = (wc: WebContents): string => {
    try {
      return ctx?.content.profiles.profileOf(wc) ?? DEFAULT_PROFILE_ID
    } catch {
      // The profile manager is not ready: everything is the default profile.
      return DEFAULT_PROFILE_ID
    }
  }

  const serviceWindow = (win: WindowContext, focused: WindowContext | null): ServiceWindow => ({
    id: win.id,
    profileId: profileOf(win.chrome),
    focused: win === focused,
    window: win.window,
    chrome: win.chrome,
    send: (event) => win.send(event),
    tabs: () => {
      const active = win.tabs.activeId()
      return win.tabs.all().flatMap((tab, index) => {
        const wc = tab.view.webContents
        if (wc.isDestroyed()) return []
        const info = win.tabs.info(tab)
        return [{ id: wc.id, windowId: win.id, index, url: info.url, title: info.title, active: tab.id === active, pinned: tab.pinned, audible: info.audible, muted: info.muted, loading: info.loading, favicon: tab.favicon }]
      })
    },
  })

  const windows = (): ServiceWindow[] => {
    if (!ctx) return []
    const focused = ctx.windows.focused()
    return ctx.windows.all().filter((w) => !w.window.isDestroyed()).map((w) => serviceWindow(w, focused))
  }

  const windowOf = (profileId: string): WindowContext | null => {
    if (!ctx) return null
    const all = ctx.windows.all().filter((w) => !w.window.isDestroyed() && profileOf(w.chrome) === profileId)
    const focused = ctx.windows.focused()
    return (focused && all.includes(focused) ? focused : all[0]) ?? null
  }

  const currentProfile = (): string => {
    const win = ctx?.windows.focused()
    return win ? profileOf(win.chrome) : DEFAULT_PROFILE_ID
  }

  const openTab = (profileId: string, url: string, opts: { active?: boolean } = {}): number | null => {
    const win = windowOf(profileId)
    if (!win) return null
    if (url.startsWith('apex://')) {
      win.tabs.openInternal(url, { newTab: true })
      return null
    }
    const tab = win.tabs.create(url, { activate: opts.active !== false })
    return tab.view.webContents.id
  }

  const confirmRemove = async (profileId: string, name: string): Promise<boolean> => {
    const win = windowOf(profileId)
    if (!win) return false
    const spec = {
      title: mainT('extensions.remove.title', { name }),
      description: mainT('extensions.remove.body'),
      icon: 'danger' as const,
      buttons: [
        { id: 'cancel', label: mainT('extensions.action.cancel'), style: 'secondary' as const, escape: true },
        { id: 'remove', label: mainT('extensions.action.remove'), style: 'destructive' as const, enter: true },
      ],
      dedupeKey: `extension-remove:${name}`,
    }
    try {
      return await dialogs.confirm(win, spec)
    } catch {
      // Without the dialog surface: the native sheet, same words.
      const { response } = await dialog.showMessageBox(win.window, { type: 'warning', message: spec.title, detail: spec.description, buttons: [mainT('extensions.action.remove'), mainT('extensions.action.cancel')], defaultId: 1, cancelId: 1 })
      return response === 0
    }
  }

  /** The installed extensions that can run, for the menus. */
  const runnable = (): ExtensionInfo[] => extensions?.services.extensions.list().filter((e) => e.enabled && e.supported) ?? []

  const menuItems = (): MenuItemModel[] => {
    const items = runnable()
    const list: MenuItemModel[] = items.map((e) => ({ id: `ext-action:${e.id}`, label: e.name, ...(e.icon ? { image: e.icon } : {}) }))
    return [
      ...list,
      ...(list.length ? [{ id: 'ext-sep', label: '', type: 'separator' as const }] : []),
      { id: 'ext-add', label: mainT('extensions.menu.add') },
      { id: 'ext-manage', label: mainT('extensions.menu.manage') },
      ...(items.length
        ? [{ id: 'ext-pin', label: mainT('extensions.menu.pin'), submenu: items.map((e) => ({ id: `ext-pin:${e.id}`, label: e.name, type: 'checkbox' as const, checked: e.pinned })) }]
        : []),
    ]
  }

  const runMenuItem = (itemId: string, windowId: number | null): void => {
    if (!extensions || !ctx) return
    const win = (windowId !== null ? ctx.windows.get(windowId) : null) ?? ctx.windows.focused()
    const profileId = win ? profileOf(win.chrome) : currentProfile()
    if (itemId === 'ext-add') return void openTab(profileId, WEB_STORE_URL)
    if (itemId === 'ext-manage') return void win?.tabs.openInternal(EXTENSIONS_SETTINGS_URL, { newTab: true })
    const [kind, id] = itemId.split(':')
    if (!id) return
    if (kind === 'ext-pin') {
      const item = extensions.host.list(profileId).find((e) => e.id === id)
      if (item) extensions.host.pin(profileId, id, !item.pinned)
      return
    }
    if (kind === 'ext-action' && win) {
      // From a menu there is no button to hang the popup on: it opens under the toolbar's right end.
      const [width] = win.window.getContentSize()
      try {
        extensions.host.runAction(profileId, id, serviceWindow(win, win), { x: (width ?? 800) - 44, y: 4, width: 32, height: 32 })
      } catch (err) {
        log.warn('extensions', 'Running an extension from the menu failed', { id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** What was right-clicked, in chrome.contextMenus' terms. */
  const menuTarget = (params: ContextMenuParams, wc: WebContents): MenuTarget => {
    const frame = asNavFrame(params.frame)
    const mediaType = params.mediaType === 'image' || params.mediaType === 'video' || params.mediaType === 'audio' ? params.mediaType : null
    return {
      pageUrl: params.pageURL || wc.getURL(),
      frameUrl: params.frameURL || null,
      frameId: frame ? frameIdOf(frame) : 0,
      linkUrl: params.linkURL || null,
      srcUrl: params.srcURL || null,
      mediaType,
      selectionText: params.selectionText ?? '',
      editable: params.isEditable,
    }
  }

  /** The page menu's extension items: one item stands alone, several sit under the extension's name (Chrome's layout). */
  const extensionMenuItems = (params: ContextMenuParams, wc: WebContents): MenuItemConstructorOptions[] => {
    if (!extensions || wc.isDestroyed()) return []
    const profileId = profileOf(wc)
    const target = menuTarget(params, wc)
    const groups = extensions.host.pageMenu(profileId, target)
    const toItem = (extensionId: string, node: MenuNode): MenuItemConstructorOptions => {
      const { item } = node
      if (item.type === 'separator') return { type: 'separator' }
      const click = (): void => extensions?.host.menuClicked(profileId, extensionId, item.id, target, wc.id)
      if (node.children.length) return { label: node.title, enabled: item.enabled, submenu: node.children.map((c) => toItem(extensionId, c)) }
      return { label: node.title, enabled: item.enabled, type: item.type === 'checkbox' ? 'checkbox' : item.type === 'radio' ? 'radio' : 'normal', ...(item.type !== 'normal' ? { checked: item.checked } : {}), click }
    }
    return groups.flatMap((g) => {
      const items = g.nodes.map((n) => toItem(g.extensionId, n))
      if (items.length === 1 && g.nodes[0]?.children.length === 0) return items
      return [{ label: g.name, submenu: items }]
    })
  }

  return {
    name: 'extensions',
    app(appCtx) {
      ctx = appCtx
      extensions = setupExtensions({
        dataDir: appCtx.dataDir,
        broadcast: appCtx.broadcast,
        windows,
        currentProfile,
        openTab,
        toast: (profileId, kind, text) => {
          const win = windowOf(profileId)
          if (win) toasts.show(win, { kind, text })
        },
        confirmRemove,
        preloads: { worker: join(__dirname, '../preload/extensionWorker.js'), frame: join(__dirname, '../preload/extensionFrame.js') },
        // A smoke run only ever starts hosts from its own throwaway folder (its fakes), never one installed on the Mac.
        nativeHostDirs: appCtx.smoke ? hostDirs(app.getPath('userData')).slice(0, 1) : hostDirs(app.getPath('userData')),
        extensionsDir: (profileId) => {
          try {
            return join(appCtx.content.profiles.dataDir(profileId), 'Extensions')
          } catch {
            return join(appCtx.dataDir, profileId === DEFAULT_PROFILE_ID ? '' : join('profiles', profileId), 'Extensions')
          }
        },
        registerShortcut: (def) => shortcuts.registerRuntime(def),
        clashesWith: (accelerator) => shortcuts.clashesWith(accelerator),
        chromeVersion: process.versions.chrome,
        offline: appCtx.smoke,
        onChanged: () => menus.invalidate(),
        contents: (tabId) => allContents.fromId(tabId) ?? null,
        frameById: (processId, routingId) => asNavFrame(webFrameMain.fromId(processId, routingId)),
        // What chrome.privacy reports while no extension holds a setting: Apex's own switches.
        browserSetting: (_profileId, key) => {
          const a = appCtx.settings.get().autofill
          if (key === 'services.passwordSavingEnabled') return a.offerSave
          if (key === 'services.autofillAddressEnabled') return a.addresses
          if (key === 'services.autofillCreditCardEnabled') return a.cards
          return a.addresses || a.cards
        },
        yieldToPasswordExtension: () => appCtx.settings.get().autofill.yieldToPasswordExtension,
      })
      appCtx.content.extensions = extensions.host

      // Manifest command keys: checked before the shortcut router, so a page can't swallow them.
      cleanups.push(
        shortcuts.addInputInterceptor((input, wc, win) => {
          if (!extensions || !win || isExtensionUrl(wc.getURL())) return 'pass'
          return extensions.host.handleKey(input, serviceWindow(win, win)) ? 'handled' : 'pass'
        }),
      )

      // Extension pages get the web permissions their manifest declares, and nothing else; they never prompt.
      cleanups.push(
        permissionPolicy.addOverride((r) => {
          const id = /^chrome-extension:\/\/([a-p]{32})/.exec(r.origin)?.[1]
          if (!id || !extensions) return null
          const profileId = extensions.host.profileOfSession(r.session)
          if (!profileId) return 'deny'
          if (!Object.hasOwn(PAGE_PERMISSIONS, r.permission)) return 'deny'
          const needs = PAGE_PERMISSIONS[r.permission]
          if (needs === null || needs === undefined) return 'allow'
          try {
            return extensions.host.grantedSet(profileId, id).permissions.includes(needs) ? 'allow' : 'deny'
          } catch {
            return 'deny'
          }
        }),
      )

      // chrome.contextMenus: each running extension's items, in the page menu's extensions section (order 50).
      cleanups.push(
        registerPageMenuSection({
          id: 'c-extension-items',
          order: 50,
          build: (params, tab) => extensionMenuItems(params, tab.view.webContents),
        }),
      )

      // SH-58: the Extensions menu; SH-54: the main menu's Extensions entry.
      cleanups.push(
        registerMenuContribution({ id: 'c-extensions', target: 'extensions', build: menuItems, run: runMenuItem }),
        registerMenuContribution({
          id: 'c-extensions-main',
          target: 'main-menu:tools',
          build: () => [{ id: 'ext-manage', label: mainT('extensions.menu.entry'), icon: 'puzzle' }],
          run: runMenuItem,
        }),
      )
      return extensions.services
    },
    session(session, info) {
      // Profile sessions arrive here through profiles.onSessionCreated; in-memory ones never hold extensions.
      if (info.private || !extensions) return
      const profileId = profileOfPartition(info.partition)
      if (profileId) extensions.host.attach(session, profileId)
    },
    window(win) {
      // A tab switch changes which tab's badge the toolbar shows.
      const update = (): void => {
        if (extensions) win.send({ type: 'extensions', items: extensions.host.list(profileOf(win.chrome)) })
      }
      win.tabs.on('activated', update)
      win.window.on('focus', update)
      // chrome.tabs.onCreated, onActivated, onUpdated and onRemoved come from one diff of the profile's tabs.
      let profileId: string | null = null
      const syncTabs = (): void => {
        if (!extensions) return
        if (profileId === null && !win.chrome.isDestroyed()) profileId = profileOf(win.chrome)
        if (profileId !== null) extensions.host.scheduleTabSync(profileId)
      }
      syncTabs()
      win.tabs.on('changed', syncTabs)

      // chrome.webNavigation: each tab's frame events, and a tab whose page view was replaced.
      const watch = (wc: WebContents): void => {
        if (extensions && !wc.isDestroyed()) extensions.host.watchContents(profileOf(wc), wc)
      }
      for (const tab of win.tabs.all()) watch(tab.view.webContents)
      win.tabs.on('created', (tab: { view: { webContents: WebContents } }) => watch(tab.view.webContents))
      win.tabs.on('view-replaced', (tab: { view: { webContents: WebContents } }, old: WebContents) => {
        const wc = tab.view.webContents
        watch(wc)
        if (extensions && !wc.isDestroyed()) extensions.host.tabReplaced(profileOf(wc), old.id, wc.id)
      })

      // chrome.windows events: created now, removed when it closes, and focus moving between windows (or away from Apex).
      const windowProfile = (): string | null => {
        if (profileId === null && !win.chrome.isDestroyed()) profileId = profileOf(win.chrome)
        return profileId
      }
      const windowEvent = (event: 'windows.onCreated' | 'windows.onRemoved' | 'windows.onFocusChanged', id: number): void => {
        const p = windowProfile()
        if (extensions && p !== null) extensions.host.windowEvent(p, event, id)
      }
      setImmediate(() => windowEvent('windows.onCreated', win.id))
      win.window.on('focus', () => windowEvent('windows.onFocusChanged', win.id))
      // One 'closed' listener for both: the tabs diff and windows.onRemoved.
      win.window.on('closed', () => {
        syncTabs()
        windowEvent('windows.onRemoved', win.id)
      })
      win.window.on('blur', () => {
        // Focus going to another Apex window reports that window instead; leaving Apex reports WINDOW_ID_NONE.
        setTimeout(() => {
          if (!ctx?.windows.all().some((w) => !w.window.isDestroyed() && w.window.isFocused())) windowEvent('windows.onFocusChanged', -1)
        }, 0)
      })
      // Per-tab action state (chrome.action.setBadgeText({ tabId })) ends with its tab; moved tabs keep theirs.
      win.tabs.on('closed', (tab: { view: { webContents: WebContents } }, info?: { moved?: boolean }) => {
        if (info?.moved || !extensions) return
        try {
          extensions.host.forgetTab(tab.view.webContents.id)
        } catch {
          // Its webContents is already gone: nothing was keyed by it that matters now.
        }
      })
    },
    dispose: async () => {
      for (const fn of cleanups.splice(0)) fn()
      await extensions?.dispose()
    },
  }
}
