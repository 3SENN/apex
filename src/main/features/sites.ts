/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isDeepStrictEqual } from 'node:util'
import { ipcMain, shell, type IpcMainEvent, type Session } from 'electron'
import { z } from 'zod'
import { PAGE } from '@shared/ipc'
import { displayHost } from '@shared/domains'
import { siteKey } from '@shared/permissions'
import type { SiteServices } from '@shared/services/sites'
import type { CaptureKind, GrantedDevice, SitePermission, SiteSettingsPatch } from '@shared/sites'
import { anyCapture, captureTracker } from '../capture'
import { DeviceChooser } from '../devices'
import { setForceDark } from '../forceDark'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { network } from '../network'
import { PermissionController } from '../permissions'
import { popups } from '../popups' // permissions pass: popups ask through their opener's tab
import { answerQuietRequest, onPermissionActivity, tabPermissionActivity } from '../permissions' // permissions pass: chips
import { oneTimeGrants } from '../permissions' // permissions pass: site info
import { profileOfWindowId } from '../profiles/windowProfiles' // permissions pass: private windows inherit their profile's blocks
import { ScreenShare } from '../screenShare'
import { clearCache, clearDomainData, clearSiteData, dataList } from '../siteData'
import { buildSiteInfo } from '../siteInfo'
import { paneAnchor, presentSurface, siteButtonAnchor, windowOfTab } from '../siteOverlay'
import { sites, type SiteStore } from '../sites'
import type { Tab } from '../tabs'
import type { AppContext, Feature, ServiceParts, WindowContext } from './types'
import { withSafety } from './sitesSafety'
import { profileDataDir } from '../profiles/paths'

// Sites, permissions, safety and page errors.
// Permissions, devices, screen share, capture, site info, per-site sound and dark mode

const PRIVACY_PANES: Record<'camera' | 'microphone' | 'screen' | 'location', { darwin: string; win32: string }> = {
  camera: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera', win32: 'ms-settings:privacy-webcam' },
  microphone: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone', win32: 'ms-settings:privacy-microphone' },
  screen: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture', win32: 'ms-settings:privacy' },
  location: { darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices', win32: 'ms-settings:privacy-location' },
}

// A document's tracker report (preload/page/capture.ts): camera, microphone, screen counts.
const captureCounts = z.tuple([z.number().int().min(0).max(999_999), z.number().int().min(0).max(999_999), z.number().int().min(0).max(999_999)])
const captureReport = z.object({ doc: z.string().regex(/^[0-9a-f]{24}$/), seen: captureCounts, live: captureCounts, gone: z.boolean() }).strict()
const countsOf = ([camera, microphone, screen]: [number, number, number]): Record<CaptureKind, number> => ({ camera, microphone, screen })

/** How long a page gets to stop its own tracks before Stop reloads it. */
const STOP_GRACE_MS = 1500

interface SitesRuntime {
  app: AppContext
  permissions: PermissionController
  screens: ScreenShare
  devices: DeviceChooser
  /** The default profile's web session, for the Settings pages. */
  webSession: Session | null
  /** Stop's reload checks waiting out the grace, per tab; a new page or a closed tab cancels them. */
  stops: Map<string, ReturnType<typeof setTimeout>>
  /** Tabs Atelier muted because their site's sound is off, so it unmutes only those. */
  mutedBySite: WeakSet<Electron.WebContents>
  /** Tabs with a sharing bar open. */
  bars: Set<string>
  ipcReady: boolean
}

let sitesRuntime: SitesRuntime | null = null

function tabOf(app: AppContext, tabId: string): Tab {
  const tab = app.tabsRegistry.get(tabId)
  if (!tab) throw new Error('That tab is no longer open.')
  return tab
}

function storeOf(session: Session | null | undefined): SiteStore {
  const store = sites.storeFor(session)
  if (!store) throw new Error('Site settings are not ready yet.')
  return store
}

function webSessionOf(s: SitesRuntime, session?: Session | null): Session {
  const chosen = session ?? s.webSession
  if (!chosen) throw new Error('Site data is not ready yet.')
  return chosen
}

/** Tabs (in every window) whose page belongs to an origin, or to a registrable domain. */
function tabsShowing(app: AppContext, match: (url: string) => boolean): Tab[] {
  return app.windows
    .all()
    .flatMap((w) => [...w.tabs.all()])
    .filter((t) => !t.view.webContents.isDestroyed() && match(t.view.webContents.getURL()))
}

/** A site's sound and dark mode, applied to a tab showing it. */
function applySite(s: SitesRuntime, tab: Tab): void {
  const wc = tab.view.webContents
  if (wc.isDestroyed()) return
  const origin = siteKey(wc.getURL())
  const settings = origin ? sites.settingsFor(wc.session, origin) : null
  const silence = settings?.sound === 'block'
  let muteChanged = false
  if (silence && !wc.isAudioMuted()) {
    wc.setAudioMuted(true)
    s.mutedBySite.add(wc)
    muteChanged = true
  } else if (!silence && s.mutedBySite.has(wc)) {
    s.mutedBySite.delete(wc)
    wc.setAudioMuted(false)
    muteChanged = true
  }
  void setForceDark(wc, settings?.forceDark === true)
  if (muteChanged) windowOfTab(s.app.windows, tab)?.tabs.refresh()
}

function stopCapture(s: SitesRuntime, tabId: string, kinds: readonly CaptureKind[]): void {
  const tab = s.app.tabsRegistry.get(tabId)
  if (!tab) return
  const wc = tab.view.webContents
  // A capture no page tracker saw (a frame without one) can only be ended by a reload.
  const untracked = captureTracker.untracked(tabId, kinds)
  // Every frame's tracker stops its own tracks.
  if (!wc.isDestroyed()) {
    for (const frame of wc.mainFrame.framesInSubtree) {
      try {
        frame.send(PAGE.captureStop, kinds)
      } catch {
        // A frame on its way out takes its tracks with it.
      }
    }
  }
  captureTracker.clear(tabId, kinds)
  // A page that ignores Stop, captures again during the grace, or whose capture the trackers can't see is reloaded so the capture really ends.
  clearTimeout(s.stops.get(tabId))
  s.stops.set(
    tabId,
    setTimeout(() => {
      s.stops.delete(tabId)
      if (wc.isDestroyed()) return
      const now = captureTracker.state(tabId)
      if (untracked || captureTracker.holds(tabId, kinds) || kinds.some((k) => now[k])) wc.reload()
    }, STOP_GRACE_MS),
  )
}

/** A frame's identity across its documents (a new document in it means the old one's tracks ended). */
function frameKey(frame: Electron.WebFrameMain): string {
  return typeof frame.frameTreeNodeId === 'number' ? `node:${frame.frameTreeNodeId}` : `${frame.processId}:${frame.routingId}`
}

/** Shows or hides a tab's sharing bar as its capture changes, and tells every surface. */
function captureChanged(s: SitesRuntime, tabId: string): void {
  const state = captureTracker.state(tabId)
  const sharedId = captureTracker.sharedTab(tabId)
  const shared = sharedId ? s.app.tabsRegistry.get(sharedId) : undefined
  const sharedTab = shared && !shared.view.webContents.isDestroyed() ? shared.view.webContents.getTitle() || null : null
  s.app.broadcast({ type: 'capture', tabId, capture: state, sharedTab })
  const tab = s.app.tabsRegistry.get(tabId)
  const win = tab ? windowOfTab(s.app.windows, tab) : null
  win?.tabs.refresh()
  if (shared) windowOfTab(s.app.windows, shared)?.tabs.refresh()
  if (!tab || !win || !anyCapture(state) || s.bars.has(tabId)) return
  const url = tab.view.webContents.isDestroyed() ? '' : tab.view.webContents.getURL()
  const origin = siteKey(url)
  if (!origin) return
  s.bars.add(tabId)
  void presentSurface(win, 'sharing-bar', paneAnchor(win, tab), { tabId, host: new URL(origin).hostname, origin, capture: state, sharedTab }, tab.id).then(() => {
    s.bars.delete(tabId)
    // The bar went away (crash, replaced) while the capture goes on: bring it back.
    if (anyCapture(captureTracker.state(tabId)) && s.app.tabsRegistry.get(tabId)) setTimeout(() => captureChanged(s, tabId), 250)
  })
}

function onCaptureReport(s: SitesRuntime, event: IpcMainEvent, payload: unknown): void {
  // Every frame of a tab reports for its own document; one that already went away is ignored.
  const tab = s.app.tabsRegistry.byWebContents(event.sender.id)
  const frame = event.senderFrame
  if (!tab || !frame || frame.detached) return
  const parsed = captureReport.safeParse(payload)
  if (!parsed.success) return
  const { doc, seen, live, gone } = parsed.data
  captureTracker.report(tab.id, { doc, frame: frameKey(frame), seen: countsOf(seen), live: countsOf(live), gone })
}

function noteDenied(s: SitesRuntime, tab: Tab, origin: string, kind: Parameters<PermissionController['noteAgent']>[2]): void {
  s.permissions.noteAgent(tab, origin, kind)
}

type ScopedSiteServices = Pick<SiteServices['sites'], 'get' | 'set' | 'permission' | 'list' | 'forget' | 'setMuted' | 'clearSiteData' | 'clearCache' | 'dataList' | 'clearDomainData'>

const DEVICE_KINDS: readonly GrantedDevice['kind'][] = ['hid', 'usb', 'serial', 'bluetooth']

/** Site info's camera, microphone and screen rows end the capture they stand for. */
const CAPTURE_KIND: Partial<Record<SitePermission, CaptureKind>> = { camera: 'camera', microphone: 'microphone', screen: 'screen' }

/**
 * The store and site-data methods for one session: the default profile's
 * (app-wide), or a window's own profile or private session, so site info's
 * Clear and the Settings lists act on the window they're used in.
 */
function scopedServices(s: SitesRuntime, sessionOf: () => Session | null): ScopedSiteServices {
  const store = (): SiteStore => storeOf(sessionOf())
  const session = (): Session => webSessionOf(s, sessionOf())
  /** Tabs of this session showing a page that matches. */
  const showing = (match: (url: string) => boolean): Tab[] => {
    const own = session()
    return tabsShowing(s.app, match).filter((t) => t.view.webContents.session === own)
  }
  return {
    get: (origin) => store().get(origin),
    set: (origin, patch) => setSite(s, session(), origin, patch),
    permission: (origin, perm) => store().permission(origin, perm),
    list: () => store().list(),
    forget: (origin) => {
      store().forget(origin)
      // A reset site keeps no devices either, remembered or not.
      s.devices.revokeSite(session(), siteKey(origin) ?? origin)
    },
    setMuted: (origin, muted) => {
      store().set(origin, { sound: muted ? 'block' : 'default' })
    },
    clearSiteData: async (origin) => {
      await clearSiteData(session(), origin)
      // Cookies are shared across the registrable domain, so every page of it reloads signed out.
      const { registrable } = displayHost(origin)
      for (const t of showing((url) => siteKey(url) === origin || (registrable !== '' && displayHost(url).registrable === registrable))) t.view.webContents.reload()
    },
    clearCache: async (origin) => {
      await clearCache(session(), origin)
      if (origin) for (const t of showing((url) => siteKey(url) === origin)) t.view.webContents.reloadIgnoringCache()
    },
    dataList: () => dataList(session()),
    clearDomainData: async (domain) => {
      await clearDomainData(session(), domain.toLowerCase())
    },
  }
}

/** A site's settings change: devices it no longer lists, and kinds now blocked, lose their session grants too. */
function setSite(s: SitesRuntime, session: Session, origin: string, patch: SiteSettingsPatch): ReturnType<SiteStore['set']> {
  const store = storeOf(session)
  const key = siteKey(origin) ?? origin
  const before = patch.devices ? store.get(origin).devices : []
  const next = store.set(origin, patch)
  for (const d of before) if (!next.devices.some((n) => n.kind === d.kind && n.id === d.id)) s.devices.revoke(session, key, d)
  const blocked = DEVICE_KINDS.filter((k) => next.permissions[k] === 'block')
  if (blocked.length > 0) s.devices.revokeSite(session, key, blocked)
  return next
}

function services(s: SitesRuntime): SiteServices['sites'] {
  const { app } = s
  return {
    ...scopedServices(s, () => s.webSession),
    info: (tabId) => {
      const tab = tabOf(app, tabId)
      const win = windowOfTab(app.windows, tab)
      return buildSiteInfo(tab, win?.tabs ?? null, {
        capture: captureTracker,
        globals: () => {
          const settings = app.settings.get()
          return { adblock: settings.adblock, popupBlocking: settings.popupBlocking !== false }
        },
        isPrivate: (t) => !t.view.webContents.isDestroyed() && s.permissions.isPrivate(t.view.webContents.session),
        // ── permissions pass: site info ──
        oneTime: (t) => oneTimeGrants(t.id),
        sessionDevices: (session, origin) => s.devices.sessionDevices(session, origin),
      })
    },
    screenSources: (requestId) => s.screens.sources(requestId),
    stopCapture: (tabId, kinds) => stopCapture(s, tabId, kinds ?? ['camera', 'microphone', 'screen']),
    openSystemSettings: (pane) => {
      const target = process.platform === 'darwin' ? PRIVACY_PANES[pane].darwin : process.platform === 'win32' ? PRIVACY_PANES[pane].win32 : null
      if (target) void shell.openExternal(target)
    },
    // ── permissions pass: site info services ──
    revokeOneTime: (tabId, perm) => {
      s.permissions.revokeOneTime(tabId, perm)
      const kind = CAPTURE_KIND[perm]
      if (kind && captureTracker.state(tabId)[kind]) stopCapture(s, tabId, [kind])
    },
    revokeDevice: (tabId, device) => {
      const wc = tabOf(app, tabId).view.webContents
      const origin = wc.isDestroyed() ? null : siteKey(wc.getURL())
      if (origin) s.devices.revoke(wc.session, origin, device)
    },
    // ── permissions pass services ──
    answerQuiet: (tabId, permission, allow) => {
      answerQuietRequest(tabId, permission, allow)
      refreshTabOf(s, tabId)
    },
  }
}

// ── permissions pass: chips ── (the pill's chips follow this page load's refused and held-back requests)
function refreshTabOf(s: SitesRuntime, tabId: string): void {
  const tab = s.app.tabsRegistry.get(tabId)
  if (tab) windowOfTab(s.app.windows, tab)?.tabs.refresh()
}

function wirePermissionChips(s: SitesRuntime): void {
  onPermissionActivity((a) => refreshTabOf(s, a.tabId))
}

function setupWindowChips(s: SitesRuntime, win: WindowContext): void {
  win.tabs.decorate((tab) => ({ permissionActivity: tabPermissionActivity(tab.id) }))
  win.tabs.on('navigated', (tab, nav) => {
    if (!nav.mainFrame || nav.inPage) return
    // A new page starts with no chips.
    s.permissions.navigated(tab.id)
    win.tabs.refresh()
  })
}

/** Window-scoped versions of the store and data methods: a profile window acts on its profile, a private window on its own memory store and session. */
function windowServices(s: SitesRuntime, win: WindowContext): Partial<SiteServices['sites']> {
  return scopedServices(s, () => win.session)
}

function onStoreChanged(s: SitesRuntime, store: SiteStore, origin: string): void {
  s.permissions.forgetOrigin(origin)
  s.app.broadcast({ type: 'site-settings', origin })
  for (const tab of tabsShowing(s.app, (url) => siteKey(url) === origin)) {
    if (sites.storeFor(tab.view.webContents.session) === store) applySite(s, tab)
  }
}

function setupSitesRuntime(app: AppContext): SitesRuntime {
  const noteForAgent = (tabId: string, text: string): void => app.agent.noteForNextResult(tabId, text)
  const state = {} as SitesRuntime
  const permissions = new PermissionController({
    windows: app.windows,
    tabsRegistry: app.tabsRegistry,
    noteForAgent,
    capture: captureTracker,
    broadcast: (e) => app.broadcast(e),
    smoke: app.smoke === true,
    // ── permissions pass deps ── (defaults and quiet prompts, Location Services, popups asking through their opener's tab)
    settings: () => app.settings.get(),
    systemLocation: async () => (await app.personal.broker.permissions()).location,
    openerOf: (wc) => popups.openerOf(wc.id),
  })
  // ── permissions pass: defaults ── (pages read their permission states again when the defaults change)
  app.settings.on('changed', (next, previous) => {
    // `previous` is a copy, so the defaults are compared by value: any other setting leaves the pages alone.
    if (!isDeepStrictEqual(next.sitePermissionDefaults, previous.sitePermissionDefaults)) permissions.refresh()
  })
  Object.assign(state, {
    app,
    permissions,
    screens: new ScreenShare({ windows: app.windows, tabsRegistry: app.tabsRegistry, capture: captureTracker, broadcast: (e) => app.broadcast(e), noteForAgent: (tab, origin) => noteDenied(state, tab, origin, ['screen']), smoke: app.smoke === true }),
    devices: new DeviceChooser(
      { windows: app.windows, tabsRegistry: app.tabsRegistry, broadcast: (e) => app.broadcast(e), noteForAgent: (tab, origin, kind) => noteDenied(state, tab, origin, [kind]), isPrivate: (session) => permissions.isPrivate(session) },
      mainT('sites.device.unnamed'),
    ),
    webSession: null,
    stops: new Map(),
    mutedBySite: new WeakSet(),
    bars: new Set(),
    ipcReady: false,
  } satisfies SitesRuntime)
  captureTracker.on('changed', (tabId) => captureChanged(state, tabId))
  wirePermissionChips(state) // permissions pass
  return state
}

/** SH-64: another profile's session keeps its site settings in that profile's data folder. */
const PROFILE_PARTITION = /^persist:atelier-profile-(.+)$/

function installSession(s: SitesRuntime, session: Session, info: { private: boolean; partition: string }): void {
  const profileId = PROFILE_PARTITION.exec(info.partition)?.[1]
  const store = sites.attach(session, { private: info.private, dataDir: profileId ? profileDataDir(s.app.dataDir, profileId) : s.app.dataDir })
  if (!info.private && !s.webSession) s.webSession = session
  store.on('changed', (origin) => onStoreChanged(s, store, origin))
  s.permissions.install(session, info)
  s.screens.install(session)
  s.devices.install(session)
}

function setupWindow(s: SitesRuntime, win: WindowContext): void {
  if (!s.ipcReady) {
    s.ipcReady = true
    ipcMain.on(PAGE.capture, (event, payload: unknown) => onCaptureReport(s, event, payload))
  }
  win.tabs.decorate((tab) => ({ capture: captureTracker.state(tab.id) }))
  // A private window honours its profile's blocks, read live and never written back.
  if (win.kind === 'private') sites.storeFor(win.session)?.inheritFrom(sites.storeForDir(profileDataDir(s.app.dataDir, profileOfWindowId(win.id))))
  setupWindowChips(s, win) // permissions pass
  // An open prompt or picker closes when the agent takes control of its tab (OV-12).
  win.tabs.on('changed', () => {
    for (const tab of win.tabs.all()) {
      if (!tab.agentControlled) continue
      s.permissions.agentTookOver(tab)
      s.screens.cancelTab(tab.id)
      s.devices.cancelTab(tab.id)
    }
  })
  win.tabs.on('navigated', (tab, nav) => {
    if (!nav.mainFrame || nav.inPage) return
    // A new page: open pickers and prompts end, and what the old page captured is over.
    s.permissions.prompts.cancelTab(tab.id)
    s.screens.cancelTab(tab.id)
    s.devices.cancelTab(tab.id)
    cancelStopCheck(s, tab.id)
    captureTracker.clear(tab.id)
    applySite(s, tab)
  })
}

/** The page Stop was meant for is gone, and its capture with it: no reload. */
function cancelStopCheck(s: SitesRuntime, tabId: string): void {
  clearTimeout(s.stops.get(tabId))
  s.stops.delete(tabId)
}

function setupTab(s: SitesRuntime, tab: Tab): () => void {
  const wc = tab.view.webContents
  const detachBluetooth = s.devices.attachTab(tab, wc.session)
  const session = wc.session
  const gone = (): void => {
    cancelStopCheck(s, tab.id)
    captureTracker.clear(tab.id)
  }
  wc.on('render-process-gone', gone)
  applySite(s, tab)
  return () => {
    detachBluetooth()
    s.permissions.forgetTab(tab.id)
    s.screens.cancelTab(tab.id)
    s.devices.cancelTab(tab.id)
    // Devices allowed without "remember" last while one of the site's tabs is open.
    s.devices.tabClosed(tab.id, session)
    gone()
  }
}

/** What smokeBrowser/sites.ts looks at: open surfaces, waiting prompts and capture. */
export const sitesSmoke = {
  /** The surfaces open in a tab's window. */
  surfaces(tab: Tab): string[] {
    const win = sitesRuntime ? windowOfTab(sitesRuntime.app.windows, tab) : null
    return win ? win.overlay.openSurfaces().map((s) => s.surface) : []
  },
  /** Permission prompts on screen and waiting. */
  prompts(): ReturnType<PermissionController['prompts']['pending']> {
    return sitesRuntime?.permissions.prompts.pending() ?? []
  },
  /** Opens site info for a tab, as the pill's site button does. */
  async openSiteInfo(tab: Tab): Promise<void> {
    const win = sitesRuntime ? windowOfTab(sitesRuntime.app.windows, tab) : null
    if (!win) throw new Error('The tab has no window.')
    void presentSurface(win, 'site-info', await siteButtonAnchor(win, tab), { tabId: tab.id }, tab.id)
  },
  capture: captureTracker,
}

// Errors, safety, network, privacy and content rules join through withSafety
export const sitesFeature: Feature = withSafety({
  name: 'sites',
  app(app): ServiceParts {
    network.onChange((online) => app.broadcast({ type: 'online', online }))
    sitesRuntime = setupSitesRuntime(app)
    return {
      sites: services(sitesRuntime),
      network: { isOnline: () => network.isOnline() },
    }
  },
  session(session, info) {
    if (sitesRuntime) installSession(sitesRuntime, session, info)
  },
  window(win): ServiceParts {
    if (!sitesRuntime) return {}
    setupWindow(sitesRuntime, win)
    return { sites: windowServices(sitesRuntime, win) }
  },
  tab(tab) {
    if (!sitesRuntime) return
    try {
      return setupTab(sitesRuntime, tab)
    } catch (err) {
      log.warn('sites', 'Could not set up site handling for a tab', { error: err instanceof Error ? err.message : String(err) })
      return
    }
  },
})
