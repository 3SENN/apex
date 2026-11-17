/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { session as electronSession } from 'electron'
import { OMNIBOX_GROUPS, type OmniboxRow } from '@shared/omnibox'
import { suggestWebApps, type WebAppsServices } from '@shared/webApps'
import { mainT } from '../i18n/mainT'
import { omnibox } from '../omnibox'
import { WebAppStore, findAppTab, iconData, openWebApp, setWebAppOpener, siteAsApp } from '../webApps'
import type { AppContext, Feature, WindowContext } from './types'

// Websites saved as apps (WA-01): the webApps service, the command bar's
// app rows, and opening an app back in its own tab. Workspace › Apps lists
// them; a tab's menu saves one.

/** Search engines aren't apps you'd save, however often they're visited. */
const NOT_APPS = ['www.google.com', 'google.com', 'www.bing.com', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'www.ecosia.org', 'search.yahoo.com', 'kagi.com']

export function createWebAppsFeature(): Feature {
  let store: WebAppStore | null = null
  /** The tab each app last opened or went back to. */
  const lastTab = new Map<string, string>()
  let offs: Array<() => void> = []

  const need = (): WebAppStore => {
    if (!store) throw new Error(mainT('platform.webApps.error.notReady'))
    return store
  }

  /** Opens an app from `asking`: back to its tab (in any window), else a new tab there. */
  const open = (ctx: AppContext, asking: WindowContext | null, id: string): void => {
    const s = need()
    const app = s.get(id)
    if (!app) throw new Error(mainT('platform.webApps.error.gone'))
    const usable = (w: WindowContext | null | undefined): w is WindowContext => Boolean(w && !w.window.isDestroyed() && (w.kind === 'normal' || w.kind === 'private'))
    const here = usable(asking) ? asking : (ctx.windows.all().find((w) => usable(w) && w.kind === 'normal') ?? null)
    // An app's tab is looked for in normal windows: a private window's tabs aren't yours to reuse.
    const wins = [here, ...ctx.windows.all().filter((w) => w !== here)].filter((w): w is WindowContext => usable(w) && w.kind === 'normal')
    const found = findAppTab(app, s.list(), lastTab.get(id) ?? null, { windows: () => wins, tabs: (w) => w.tabs.all().map((t) => ({ id: t.id, url: w.tabs.info(t).url })) })
    if (found) {
      found.win.window.focus()
      found.win.tabs.activate(found.tabId)
      lastTab.set(id, found.tabId)
    } else {
      if (!here) throw new Error(mainT('platform.webApps.error.noWindow'))
      lastTab.set(id, here.tabs.create(app.url).id)
    }
    s.touch(id)
  }

  return {
    name: 'web-apps',
    app(ctx) {
      store = new WebAppStore(ctx.dataDir, (items) => ctx.broadcast({ type: 'web-apps', items }))
      setWebAppOpener((win, id) => open(ctx, win, id))
      offs = [
        omnibox.registerProvider({
          id: 'web-apps',
          group: OMNIBOX_GROUPS.apps,
          order: 74,
          maxRows: 4,
          query: async (text) => {
            const q = text.trim().toLowerCase()
            if (q.length < 1 || !store) return []
            return store.list().flatMap((a): OmniboxRow[] => {
              const host = new URL(a.url).host.replace(/^www\./, '')
              const at = a.name.toLowerCase().indexOf(q)
              if (at < 0 && !host.includes(q)) return []
              return [{ id: `web-app:${a.id}`, group: OMNIBOX_GROUPS.apps, title: a.name, subtitle: host, icon: 'globe', url: a.url, ...(at >= 0 ? { match: [[at, at + q.length]] as [number, number][] } : {}), action: { kind: 'web-app', appId: a.id } }]
            })
          },
        }),
        () => setWebAppOpener(null),
      ]
      const services: WebAppsServices['webApps'] = {
        list: () => need().list(),
        async saveTab(tabId) {
          for (const win of ctx.windows.all()) {
            const tab = win.tabs.find(tabId)
            if (!tab) continue
            const wc = tab.view.webContents
            if (wc.isDestroyed() || !/^https?:/i.test(wc.getURL())) throw new Error(mainT('platform.webApps.error.notWeb'))
            const app = need().byUrl(wc.getURL()) ?? need().add(await siteAsApp(wc, tab.favicon))
            // The tab it was saved from is its tab: opening it goes back there, not to another page on the site.
            lastTab.set(app.id, tabId)
            return app
          }
          throw new Error(mainT('platform.webApps.error.tabGone'))
        },
        async saveUrl(url, name) {
          const known = need().byUrl(url)
          if (known) return known
          const origin = new URL(url).origin
          const icon = await iconData(electronSession.defaultSession, `${origin}/favicon.ico`)
          return need().add({ name, url, icon })
        },
        rename: (id, name) => need().rename(id, name),
        remove: (id) => {
          need().remove(id)
          lastTab.delete(id)
        },
        open: (id) => open(ctx, ctx.windows.focused(), id),
        suggestions: () => suggestWebApps(ctx.workspaceStores?.history.search('', 5000) ?? [], need().list(), Date.now(), NOT_APPS),
      }
      return { webApps: services }
    },
    // The asking window opens the app (or goes back to its tab).
    window: (win) => ({ webApps: { open: (id: string) => void openWebApp(win, id) } }),
    dispose() {
      for (const off of offs) off()
      offs = []
      store = null
    },
  }
}
