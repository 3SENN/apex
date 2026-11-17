/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The platform feature module (`platform` in FEATURES): sandboxed agent apps,
// CSV tables, apex://flags, the Calendar and Reminders helper, app links
// and site suggestions.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app as electronApp, shell, type Session } from 'electron'
import { APP_LINK_RULES, type AppLinkRule } from '@shared/appLinks'
import { APEX_APP_PARTITION_PREFIX, parseAppUrl, type AppSummary } from '@shared/apps'
import { isAppRunUrl } from '@shared/url'
import { DEFAULT_ACTIVITY_SETTINGS } from '@shared/activity'
import { isExcluded } from '@shared/exclusions'
import { isFlagOn } from '@shared/flags'
import type { Services } from '@shared/services'
import type { SuggestionConnector } from '@shared/siteSuggestions'
import { contributeToolSetup, type ToolSetup } from '../agent/tools/registry'
import { handleApexAppElsewhere } from '../appProtocol'
import { CalendarService, calendarHelperPath } from '../calendar'
import { openDb } from '../db'
import { createFlags } from '../flags'
import type { AppContext, Feature, SessionInfo, WindowContext } from '../features/types'
import { log } from '../log'
import { setCalendarSource } from '../meetings/capture'
import { appRoot } from '../resources'
import { SiteSuggestions } from '../siteSuggestions'
import type { Tab } from '../tabs'
import { workerReader } from '../tables/queryClient'
import { createTablesService } from '../tables/service'
import { TableStore } from '../tables/store'
import { registerTableTools } from '../tables/tools'
import { registerCalendarTools } from './calendarTools'
import { previewDraft, type DraftPreview } from './preview'
import { createAppSandbox, type AppSandbox } from './protocol'
import { createAppsService } from './service'
import { AppStore } from './store'
import { registerAppTools } from './tools'
import { appUiStyle, kitUiCss } from './ui'

// ── Late bindings (the merged services and the session installer exist only after every feature started) ──

let boundServices: Services | null = null
let boundInstall: ((session: Session, info: SessionInfo) => void) | null = null

/** index.ts calls this once the services are merged: site suggestions read connectors, chats and exclusions through them, and app partitions get the webRequest mux. */
export function bindPlatformServices(services: Services, installSession: (session: Session, info: SessionInfo) => void): void {
  boundServices = services
  boundInstall = installSession
}

/** For the agent's ToolSetup: which of the platform's tool groups a new chat may get (flags and the calendar opt-in). */
export function platformWorkspaceSetup(flags: Record<string, string>): Pick<ToolSetup['workspace'], 'tables' | 'apps' | 'calendar'> {
  return { tables: isFlagOn(flags, 'tables'), apps: isFlagOn(flags, 'apps'), calendar: calendarRef?.enabled('events') === true || calendarRef?.enabled('reminders') === true }
}

let calendarRef: CalendarService | null = null
let appStoreRef: AppStore | null = null

/** The running app store (Share as pack reads an app's HTML); null before start-up. */
export function appStoreInstance(): AppStore | null {
  return appStoreRef
}

/** Smoke: what open-in-app would have opened (nothing is launched in smoke). */
export const smokeOpened: string[] = []

/** Smoke: build_app's look at a draft (APP-UI), set once the sandbox exists. */
export const appsSmoke: { preview: ((appId: string, versionId: string) => Promise<DraftPreview>) | null } = { preview: null }

/** A test-only app link for the smoke fixture server. */
const SMOKE_LINK: AppLinkRule = { key: 'smoke', app: 'Apex Test App', scheme: 'apex-smoke', hosts: ['127.0.0.1', 'localhost'], map: (url) => `apex-smoke://open${url.pathname}` }

/** Registers the platform's client tools; the feature calls it with its stores. Kept under its contract name. */
export function registerPlatformTools(deps?: { apps: Parameters<typeof registerAppTools>[0]; tables: Parameters<typeof registerTableTools>[0]; calendar: CalendarService }): void {
  if (!deps) return
  registerAppTools(deps.apps)
  registerTableTools(deps.tables)
  registerCalendarTools(deps.calendar)
}

function tabUrl(tab: Tab | undefined): string | null {
  if (!tab || tab.internalUrl || tab.view.webContents.isDestroyed()) return null
  return tab.view.webContents.getURL() || tab.requestedUrl || null
}

export function createPlatformFeatures(): Feature {
  let sandbox: AppSandbox | null = null
  let suggestions: SiteSuggestions | null = null
  let tableStore: TableStore | null = null
  let calendar: CalendarService | null = null

  const hardenTab = (tab: Tab): void => {
    if (!sandbox || !tab.sandbox || !sandbox.isAppSession(tab.sandbox)) return
    const appId = parseAppUrl(tab.requestedUrl || tab.view.webContents.getURL())?.appId
    if (appId) sandbox.harden(tab.view.webContents, appId)
  }

  return {
    name: 'platform',
    app(ctx: AppContext) {
      const services = (): Services | null => boundServices
      const exportDir = ctx.smoke ? mkdtempSync(join(tmpdir(), 'apex-smoke-d6-')) : null

      // Flags.
      const flags = createFlags({ settings: ctx.settings, broadcast: ctx.broadcast, relaunch: ctx.smoke ? () => log.info('flags', 'relaunch skipped in smoke') : undefined })

      // Apps.
      const appStore = new AppStore(ctx.dataDir)
      appStoreRef = appStore
      // APP-UI: every app is served with Apex UI in the colours of the companion that made it.
      const appAccent = (appId: string): string | null => {
        const companions = services()?.companions.list() ?? []
        let app: AppSummary | null = null
        try {
          app = appStore.get(appId)
        } catch {
          return null
        }
        const maker = companions.find((c) => c.id === app.owner) ?? companions.find((c) => c.id === app.createdBy) ?? companions.find((c) => c.id === services()?.companions.activeId())
        return maker?.look.colors.accent ?? null
      }
      sandbox = createAppSandbox(appStore, () => boundInstall, (appId) => appUiStyle(kitUiCss(), appAccent(appId)))
      const appSandbox = sandbox
      const focusedWindow = (): WindowContext | null => ctx.windows.focused() ?? ctx.windows.all()[0] ?? null
      const apps = createAppsService({
        store: appStore,
        sandbox: appSandbox,
        broadcast: ctx.broadcast,
        openTab(url) {
          const win = focusedWindow()
          const target = parseAppUrl(url)
          if (!win || !target) throw new Error('Open a window first.')
          const existing = win.tabs.all().find((t) => t.requestedUrl === url || (!t.view.webContents.isDestroyed() && t.view.webContents.getURL() === url))
          if (existing) return win.tabs.activate(existing.id)
          win.tabs.create(url, { afterId: win.tabs.activeId() ?? undefined, sandbox: { session: appSandbox.session(target.appId) } })
        },
        startChat: (text, options) => ctx.agent.startChat(text, options),
        activeCompanion: () => services()?.companions.activeId() ?? 'shared',
        savePath: exportDir ? (name) => join(exportDir, `${name}.html`) : undefined,
      })

      // Tables.
      tableStore = new TableStore(ctx.dataDir, openDb)
      const tables = createTablesService({
        store: tableStore,
        dataDir: ctx.dataDir,
        broadcast: ctx.broadcast,
        // Smoke picks the fixture through the environment instead of a dialog.
        pickPath: ctx.smoke ? () => process.env.APEX_SMOKE_TABLE_CSV ?? null : undefined,
        savePath: exportDir ? (name) => join(exportDir, `${name}.csv`) : undefined,
      })

      // Calendar and Reminders.
      calendar = new CalendarService({
        dataDir: ctx.dataDir,
        helper: () => calendarHelperPath({ packaged: electronApp.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot() }),
        broadcast: ctx.broadcast,
        openExternal: (url) => void shell.openExternal(url),
        setSource: setCalendarSource,
        watch: flags.isOn('calendar-watch'),
      })
      calendarRef = calendar
      // New chats get the calendar tools while either kind is switched on (each tool checks its own kind).
      const cal = calendar
      contributeToolSetup(() => ({ calendar: cal.enabled('events') || cal.enabled('reminders') }))
      void calendar.status()

      appsSmoke.preview = (appId, versionId) => previewDraft(appSandbox, appId, versionId)
      registerPlatformTools({
        apps: { store: appStore, changed: apps.changed, preview: (appId, versionId) => previewDraft(appSandbox, appId, versionId) },
        tables: { store: tableStore, read: workerReader(), changed: tables.changed },
        calendar,
      })

      // Site suggestions and open-in-app.
      const rules = ctx.smoke ? [...APP_LINK_RULES, SMOKE_LINK] : APP_LINK_RULES
      suggestions = new SiteSuggestions({
        dataDir: ctx.dataDir,
        tabUrl: (tabId) => tabUrl(ctx.tabsRegistry.get(tabId)),
        connectors: () =>
          (services()?.connectors.list() ?? []).map(
            (c): SuggestionConnector => ({ id: c.id, name: c.name, enabled: c.enabled, url: c.url, directoryId: (c as { directoryId?: string | null }).directoryId ?? null }),
          ),
        directory: () => (services()?.connectors.directory() ?? []).map((e) => ({ id: e.id, name: e.name, site: e.site })),
        excluded: (url) => {
          let excluded = DEFAULT_ACTIVITY_SETTINGS.excluded
          try {
            excluded = services()?.activity.settings().excluded ?? excluded
          } catch {
            // Activity memory not ready: the default categories still apply.
          }
          return isExcluded(url, excluded)
        },
        installed: (scheme) => (ctx.smoke && scheme === SMOKE_LINK.scheme) || electronApp.getApplicationNameForProtocol(`${scheme}://`) !== '',
        openExternal: (url) => {
          if (ctx.smoke) smokeOpened.push(url)
          else void shell.openExternal(url)
        },
        newChat: () => ctx.agent.create({}).id,
        chatExists: (chatId) => {
          try {
            services()?.chats.get(chatId)
            return true
          } catch {
            return false
          }
        },
        broadcast: ctx.broadcast,
        rules,
      })
      const site = suggestions

      // `changed` is main's own hook for the agent tools, not a method the renderer reaches.
      const { changed: _appsChanged, ...appsMethods } = apps
      const { changed: _tablesChanged, ...tablesMethods } = tables
      return {
        apps: appsMethods,
        tables: tablesMethods,
        flags: { list: flags.list, set: flags.set, relaunch: flags.relaunch },
        calendar: {
          status: () => calendar!.status(),
          requestAccess: (kind) => calendar!.requestAccess(kind),
          setEnabled: (kind, on) => calendar!.setEnabled(kind, on),
          upcoming: (range) => calendar!.upcoming(range),
          reminders: () => calendar!.reminders(),
          openPrivacySettings: (kind) => calendar!.openPrivacySettings(kind),
        },
        siteSuggestions: {
          current: (tabId) => site.current(tabId),
          settings: () => site.settings(),
          update: (patch) => site.update(patch),
          dismiss: (tabId, scope) => site.dismiss(tabId, scope),
          draft: (tabId, taskId, target) => site.draft(tabId, taskId, target),
          openInApp: (tabId) => site.openInApp(tabId),
          appLink: (tabId) => {
            const url = tabUrl(ctx.tabsRegistry.get(tabId))
            const link = url ? site.appLink(url) : null
            return link ? { app: link.app } : null
          },
        },
      }
    },
    session(session, info) {
      // Every other session answers apex-app:// with a plain page; only an app's own partition serves it.
      if (!info.partition.startsWith(APEX_APP_PARTITION_PREFIX)) handleApexAppElsewhere(session)
    },
    window(win) {
      win.tabs.on('navigated', (tab, nav) => {
        if (nav.mainFrame) suggestions?.refresh(tab.id)
      })
      win.tabs.on('activated', (tab) => suggestions?.refresh(tab.id))
      // A sleeping tab wakes in a fresh view: it needs the app rules again.
      win.tabs.on('view-replaced', (tab) => hardenTab(tab))
    },
    tab(tab, win) {
      hardenTab(tab)
      // An apex-app:// address opened as a plain tab (a link, Workspace's file
      // opener) reopens in its own sandbox: the web session never serves apps.
      if (!tab.sandbox && sandbox && isAppRunUrl(tab.requestedUrl)) {
        const target = parseAppUrl(tab.requestedUrl)
        const box = sandbox
        if (target && appStoreRef?.has(target.appId)) {
          queueMicrotask(() => {
            if (!win.tabs.all().some((t) => t.id === tab.id)) return
            const active = win.tabs.activeId() === tab.id
            win.tabs.create(tab.requestedUrl, { afterId: tab.id, activate: active, sandbox: { session: box.session(target.appId) } })
            win.tabs.close(tab.id)
          })
        }
      }
      return () => suggestions?.forget(tab.id)
    },
    dispose() {
      calendar?.dispose()
      tableStore?.close()
    },
  }
}
