/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, Input, ServiceWorkerMain, Session, WebContents } from 'electron'
import { launchRefused } from '@shared/applePasswords'
import { EXTENSION_ID, normalizeBadgeColor, storeDetailUrl, type ExtensionInfo, type ExtensionInstallPrompt, type ExtensionNativePrompt } from '@shared/extensions'
import { EXT_SHIM_EVENT, type ExtListenEvent, type ExtNavEvent, type ExtShimEvent } from '@shared/extensionShim'
import type { Bounds } from '@shared/ipc'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { normalizeAccelerator, type RegisterRuntimeResult, type RuntimeShortcut } from '../shortcuts'
import type { ExtensionsAdapter } from './adapter'
import { EXECUTE_ACTION, inputAccelerator, manifestCommands, type ExtensionCommand } from './commands'
import { classifyCompat, type Compat } from './compat'
import { afterClick, clickData, createItem, removeItem, restoreItems, updateItem, visibleTree, type MenuItem, type MenuNode, type MenuTarget } from './contextMenus'
import { applyContentCompat } from './contentCompat'
import { idFromPublicKey, unpackArchive, verifyCrx, writeManifestKey } from './crx'
import { addRules, getRules, removeRules, rulesShowAction, type ContentRule } from './declarativeContent'
import { actionOf, iconDataUrl, localize, permissionLists, pickIcon, readManifest, type Manifest } from './manifest'
import { NativePort, findHost, hostArgs, sendOnce } from './nativeMessaging'
import { describePermissions, hostsPhrase, phraseFor, type DescribedPermissions } from './permissions'
import { PopupHost } from './popup'
import { checkSet, isPrivacyKey, settingDetails, winningHold, type PrivacyKey, type SettingDetails, type SettingHold } from './privacySettings'
import { ExtensionStateStore, type ExtensionRecord } from './store'
import { allFrames, asNavContents, findFrame, frameDetails, watchNavigation, type NavFrame } from './webNavigation'

// ExtensionsHost: one per app, holding each profile session's
// extensions. It loads what the per-profile store says on attach, keeps the
// action state the shims report (badge, title, popup), registers manifest
// commands, runs popups and native-messaging ports, and installs verified
// Web Store packages. Electron itself is reached only through the adapter.

/** A window the host can anchor popups in and send prompts to. */
export interface HostWindow {
  id: number
  profileId: string
  focused: boolean
  window: BrowserWindow
  chrome: WebContents
  /** The window's tabs, for chrome.tabs.query and per-tab badges. */
  tabs(): HostTab[]
}

export interface HostTab {
  /** webContents id: the tab id Electron's extension APIs already use. */
  id: number
  windowId: number
  index: number
  url: string
  title: string
  active: boolean
  pinned: boolean
  audible: boolean
  muted: boolean
  loading: boolean
  favicon: string | null
}

export interface HostDeps {
  adapter: ExtensionsAdapter
  /** Built preload paths; null in unit tests, where nothing is registered. */
  preloads: { worker: string; frame: string } | null
  extensionsDir(profileId: string): string
  nativeHostDirs: string[]
  windows(): HostWindow[]
  /** Opens a URL in a tab of the profile's focused window; returns its webContents id. */
  openTab(profileId: string, url: string, opts?: { active?: boolean }): number | null
  /** The list changed for a profile: the service re-sends it. */
  changed(profileId: string): void
  askInstall(profileId: string, prompt: Omit<ExtensionInstallPrompt, 'id'>): Promise<boolean>
  askNative(profileId: string, prompt: Omit<ExtensionNativePrompt, 'id'>): Promise<'once' | 'always' | 'deny'>
  toast(profileId: string, kind: 'success' | 'error' | 'info', text: string): void
  registerShortcut(def: RuntimeShortcut): RegisterRuntimeResult
  clashesWith(accelerator: string): string | null
  /** Chrome's version for the Web Store and update checks. */
  chromeVersion: string
  /** A tab's webContents by id (webContents.fromId), for chrome.webNavigation; only ones in the profile's session are used. */
  contents?(tabId: number): WebContents | null
  /** A frame by its process and routing ids (webFrameMain.fromId), for webNavigation's events. */
  frameById?(processId: number, routingId: number): NavFrame | null
  /** Atelier's own value for a browser setting that chrome.privacy reports when no extension holds it. */
  browserSetting?(profileId: string, key: PrivacyKey): boolean
}

/** What observers of the host see (the Apple Passwords card reads its native port this way). */
export type HostObservation =
  | { type: 'native'; profileId: string; extensionId: string; host: string; event: 'open' | 'message' | 'post' | 'close'; message?: unknown; error?: string | null }
  | { type: 'setting'; profileId: string; key: PrivacyKey }

/** The last native port an extension opened to a host: whether it is open and whether the host has answered. */
export interface NativeSeen {
  open: boolean
  replied: boolean
  closedWithError: string | null
  /** The host was refused at launch: killed at exec, or gone at once without a word (shared/applePasswords.ts launchRefused). */
  launchRefused?: boolean
}

interface Known {
  id: string
  dir: string
  manifest: Manifest
  name: string
  description: string
  version: string
  icon: string | null
  compat: Compat
  perms: DescribedPermissions
  commands: ExtensionCommand[]
}

type TabKey = number | 'all'

interface ActionState {
  badge: Map<TabKey, string>
  color: Map<TabKey, string>
  title: Map<TabKey, string>
  popup: Map<TabKey, string>
  disabled: Set<TabKey>
  icon: string | null
  /** The path the extension last gave chrome.action.setIcon (its own file name), or null. */
  iconPath: string | null
}

interface PortEntry {
  extensionId: string
  hostName: string
  port: NativePort
  send(name: ExtShimEvent, ...args: unknown[]): void
}

/** Where the shim call came from: the extension's service worker, or one of its pages. */
export interface ShimCaller {
  extensionId: string
  send(name: ExtShimEvent, ...args: unknown[]): void
  /** The page's webContents, for window.close(); null for the worker. */
  webContents: WebContents | null
  /** Keeps the caller alive while a native port is open (a worker would otherwise stop when idle); returns the release. */
  keepAlive(): () => void
  /** The calling frame when it isn't its webContents' main frame (an extension iframe in a tab): its listeners are its own. */
  frameKey?: object
  /** Whether the calling page can still hear events. */
  alive?(): boolean
}

class Profile {
  readonly known = new Map<string, Known>()
  readonly action = new Map<string, ActionState>()
  readonly workers = new Map<string, ServiceWorkerMain>()
  readonly shortcuts = new Map<string, Array<() => void>>()
  readonly clashes = new Map<string, Map<string, string | null>>()
  readonly ports = new Map<string, PortEntry>()
  /** Native hosts refused this run ("Don't allow" isn't remembered across launches). */
  readonly refused = new Set<string>()
  /** Web Store ids approved by the install prompt, waiting for completeInstall. */
  readonly approved = new Set<string>()
  readonly store: ExtensionStateStore
  unsubscribe: (() => void) | null = null
  /** Events (tabs, webNavigation, windows, privacy, contextMenus) each extension's worker listens for. Kept for the run, so a stopped worker is woken for them as Chrome does. */
  readonly tabWorkers = new Map<string, Set<ExtListenEvent>>()
  /** Extension pages (popups, options, extension tabs) listening for those events. */
  readonly tabPages = new Map<object, { extensionId: string; events: Set<ExtListenEvent>; send: ShimCaller['send']; alive: () => boolean }>()
  /** The last native port per extension and host ("<id>\n<host>"). */
  readonly nativeSeen = new Map<string, NativeSeen>()
  /** Tabs whose frame events feed chrome.webNavigation, by webContents id. */
  readonly navWatch = new Map<number, { unwatch: () => void; errored: Set<number> }>()
  /** The profile's tabs at the last sync, by id; null until the first sync sets the baseline. */
  tabSnapshot: Map<number, HostTab> | null = null
  tabSyncTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly id: string,
    readonly session: Session,
    readonly dir: string,
  ) {
    this.store = new ExtensionStateStore(join(dir, 'atelier-state.json'))
  }
}

const emptyAction = (): ActionState => ({ badge: new Map(), color: new Map(), title: new Map(), popup: new Map(), disabled: new Set(), icon: null, iconPath: null })

/** Store installs live in <dir>/<id>/<version>_0; the newest version folder wins. */
function latestVersionDir(root: string): string | null {
  if (!existsSync(root)) return null
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'manifest.json')))
    .map((d) => ({ path: join(root, d.name), mtime: statSync(join(root, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return dirs[0]?.path ?? null
}

/** Compares dotted versions numerically: 1.10 > 1.9. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export class ExtensionsHost {
  readonly #deps: HostDeps
  readonly #profiles = new Map<string, Profile>()
  readonly #popups = new Map<number, PopupHost>()
  #portSeq = 0

  constructor(deps: HostDeps) {
    this.#deps = deps
  }

  // ── sessions ──

  /** Runs per persistent profile session (Feature.session): registers the shims, then loads the profile's extensions. */
  attach(session: Session, profileId: string): void {
    if (this.#profiles.has(profileId)) return
    const dir = this.#deps.extensionsDir(profileId)
    mkdirSync(dir, { recursive: true })
    const profile = new Profile(profileId, session, dir)
    this.#profiles.set(profileId, profile)
    if (this.#deps.preloads) this.#deps.adapter.installPreloads(session, this.#deps.preloads)
    this.#watchWorkers(profile)
    profile.unsubscribe = this.#deps.adapter.onUnloaded(session, (id) => {
      this.#unregisterCommands(profile, id)
      this.#deps.changed(profileId)
    })
    void this.#loadAll(profile)
  }

  /** Unloads a profile's extensions and stops its ports (profile deletion, quit). */
  async detach(profileId: string): Promise<void> {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    for (const popup of this.#popups.values()) popup.close()
    for (const entry of profile.ports.values()) entry.port.disconnect()
    profile.ports.clear()
    for (const id of [...profile.shortcuts.keys()]) this.#unregisterCommands(profile, id)
    profile.unsubscribe?.()
    for (const ext of this.#deps.adapter.all(profile.session)) this.#deps.adapter.unload(profile.session, ext.id)
    this.#profiles.delete(profileId)
  }

  profileIds(): string[] {
    return [...this.#profiles.keys()]
  }

  /** The profile a session belongs to, for IPC from extension workers and pages. */
  profileOfSession(session: Session): string | null {
    for (const p of this.#profiles.values()) if (p.session === session) return p.id
    return null
  }

  async #loadAll(profile: Profile): Promise<void> {
    for (const id of profile.store.ids()) {
      const rec = profile.store.get(id)
      if (!rec) continue
      const dir = rec.source === 'unpacked' ? rec.path : latestVersionDir(join(profile.dir, id))
      if (!dir || !existsSync(join(dir, 'manifest.json'))) {
        log.warn('extensions', 'An installed extension is missing on disk; forgetting it', { id })
        profile.store.remove(id)
        continue
      }
      this.#remember(profile, id, dir)
      if (rec.enabled) await this.#load(profile, id)
    }
    this.#deps.changed(profile.id)
  }

  #remember(profile: Profile, id: string, dir: string): Known | null {
    const manifest = readManifest(dir)
    if (!manifest) return null
    const known: Known = {
      id,
      dir,
      manifest,
      name: localize(dir, manifest, manifest.name) || id,
      description: localize(dir, manifest, manifest.description),
      version: typeof manifest.version === 'string' ? manifest.version : '0',
      icon: iconDataUrl(dir, pickIcon(manifest.icons ?? actionOf(manifest).default_icon, 48)),
      compat: classifyCompat(manifest, this.#deps.adapter.apis),
      perms: describePermissions(manifest),
      commands: manifestCommands(manifest),
    }
    profile.known.set(id, known)
    if (!profile.action.has(id)) profile.action.set(id, emptyAction())
    return known
  }

  async #load(profile: Profile, id: string): Promise<boolean> {
    const known = profile.known.get(id)
    if (!known) return false
    // Unsupported extensions stay installed but never run (OV-16): no half-working.
    if (!known.compat.supported) return false
    // Store installs are Atelier's own copy: one installed before the content-script prelude existed gets it now.
    if (profile.store.get(id)?.source === 'store') {
      try {
        applyContentCompat(known.dir)
      } catch (err) {
        log.warn('extensions', 'Could not add the content-script prelude', { id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    try {
      const loaded = await this.#deps.adapter.load(profile.session, known.dir)
      if (loaded.id !== id) {
        this.#deps.adapter.unload(profile.session, loaded.id)
        throw new Error(`Loaded as ${loaded.id}`)
      }
      this.#registerCommands(profile, known)
      return true
    } catch (err) {
      log.warn('extensions', 'An extension failed to load', { id, error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  #unload(profile: Profile, id: string): void {
    this.#unregisterCommands(profile, id)
    for (const [portId, entry] of profile.ports) {
      if (entry.extensionId !== id) continue
      entry.port.disconnect()
      profile.ports.delete(portId)
    }
    for (const popup of this.#popups.values()) if (popup.extensionId === id) popup.close()
    this.#deps.adapter.unload(profile.session, id)
    profile.workers.delete(id)
  }

  // ── the list ──

  list(profileId: string): ExtensionInfo[] {
    const profile = this.#profiles.get(profileId)
    if (!profile) return []
    const activeTab = this.#activeTabId(profileId)
    const popupOpen = new Set([...this.#popups.values()].map((p) => p.extensionId).filter((id): id is string => id !== null))
    const order = profile.store.pinOrder()
    const items = [...profile.known.values()].map((k) => this.#info(profile, k, activeTab, popupOpen.has(k.id)))
    // Pinned in pin order first, then the rest by name.
    return items.sort((a, b) => {
      const pa = order.indexOf(a.id)
      const pb = order.indexOf(b.id)
      if (pa >= 0 || pb >= 0) return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb)
      return a.name.localeCompare(b.name)
    })
  }

  #info(profile: Profile, k: Known, tab: number | null, popupOpen: boolean): ExtensionInfo {
    const rec = profile.store.get(k.id) as ExtensionRecord
    const state = profile.action.get(k.id) ?? emptyAction()
    const pick = <T>(map: Map<TabKey, T>): T | undefined => (tab !== null && map.has(tab) ? map.get(tab) : map.get('all'))
    const badgeText = pick(state.badge) ?? ''
    const clashes = profile.clashes.get(k.id)
    const action = actionOf(k.manifest)
    const popup = pick(state.popup) ?? action.default_popup ?? ''
    return {
      id: k.id,
      name: k.name,
      version: k.version,
      description: k.description,
      icon: state.icon ?? k.icon,
      enabled: rec.enabled,
      pinned: rec.pinned,
      permissions: k.perms.permissions,
      optional: k.perms.optional.map((p) => ({ ...p, granted: rec.granted.includes(p.id) })),
      siteAccess: k.perms.siteAccess,
      hosts: k.perms.hosts,
      supported: k.compat.supported,
      unsupportedReason: k.compat.reason,
      hasPopup: popup !== '',
      badge: badgeText ? { text: badgeText.slice(0, 4), color: pick(state.color) ?? '' } : null,
      storeUrl: rec.source === 'store' ? storeDetailUrl(k.id) : null,
      commands: k.commands.map((c) => ({ name: c.description || (c.name === EXECUTE_ACTION ? mainT('extensions.command.openAction') : c.name), shortcut: c.accelerator, clash: clashes?.get(c.name) ?? null })),
      popupOpen,
      title: pick(state.title) ?? action.default_title ?? k.name,
      source: rec.source,
    }
  }

  #activeTabId(profileId: string): number | null {
    const win = this.#deps.windows().find((w) => w.profileId === profileId && w.focused) ?? this.#deps.windows().find((w) => w.profileId === profileId)
    return win?.tabs().find((t) => t.active)?.id ?? null
  }

  // ── management ──

  #need(profileId: string, id: string): { profile: Profile; known: Known } {
    const profile = this.#profiles.get(profileId)
    const known = profile?.known.get(id)
    if (!profile || !known) throw new Error(mainT('extensions.error.notInstalled'))
    return { profile, known }
  }

  async setEnabled(profileId: string, id: string, on: boolean): Promise<void> {
    const { profile } = this.#need(profileId, id)
    profile.store.upsert(id, { enabled: on })
    if (on) await this.#load(profile, id)
    else this.#unload(profile, id)
    this.#deps.changed(profileId)
  }

  pin(profileId: string, id: string, on: boolean): void {
    const { profile } = this.#need(profileId, id)
    profile.store.upsert(id, { pinned: on })
    this.#deps.changed(profileId)
  }

  /** Uninstalls and clears everything the extension stored. The chrome confirmed first. */
  async remove(profileId: string, id: string): Promise<void> {
    const { profile, known } = this.#need(profileId, id)
    const rec = profile.store.get(id)
    this.#unload(profile, id)
    try {
      await profile.session.clearStorageData({ origin: `chrome-extension://${id}` })
    } catch (err) {
      log.warn('extensions', 'Clearing an extension’s data failed', { id, error: err instanceof Error ? err.message : String(err) })
    }
    // Store installs are Atelier's own copy; an unpacked folder is the developer's and stays.
    if (rec?.source !== 'unpacked') rmSync(join(profile.dir, id), { recursive: true, force: true })
    profile.store.remove(id)
    profile.known.delete(id)
    profile.action.delete(id)
    profile.clashes.delete(id)
    this.#deps.toast(profileId, 'info', mainT('extensions.toast.removed', { name: known.name }))
    this.#deps.changed(profileId)
  }

  /** Takes back one optional permission or all of them; the extension restarts so it sees the change. */
  async revoke(profileId: string, id: string, permission: string): Promise<void> {
    const { profile } = this.#need(profileId, id)
    const rec = profile.store.get(id)
    if (!rec) return
    const removed = permission === 'all' ? rec.granted : rec.granted.filter((p) => p === permission)
    if (removed.length === 0) return
    profile.store.upsert(id, { granted: rec.granted.filter((p) => !removed.includes(p)) })
    // Taking everything back also forgets this run's native-host refusals, so the extension can ask afresh.
    if (permission === 'all') for (const key of [...profile.refused]) if (key.startsWith(`${id}:`)) profile.refused.delete(key)
    this.#emitTo(profile, id, 'permissions.onRemoved', this.#split(removed))
    if (rec.enabled) {
      this.#unload(profile, id)
      await this.#load(profile, id)
    }
    this.#deps.changed(profileId)
  }

  /** Loads a folder as an unpacked extension (developer installs and smoke fixtures). */
  async loadUnpacked(profileId: string, dir: string): Promise<string> {
    const profile = this.#profiles.get(profileId)
    if (!profile) throw new Error(mainT('extensions.error.noProfile'))
    const manifest = readManifest(dir)
    if (!manifest) throw new Error(mainT('extensions.error.noManifest'))
    const compat = classifyCompat(manifest, this.#deps.adapter.apis)
    if (!compat.supported) {
      // Unsupported ones are still listed (with the notice), never run.
      const id = unpackedId(dir, manifest)
      profile.store.upsert(id, { source: 'unpacked', path: dir, enabled: false }, 'unpacked')
      this.#remember(profile, id, dir)
      this.#deps.changed(profileId)
      return id
    }
    const loaded = await this.#deps.adapter.load(profile.session, dir)
    profile.store.upsert(loaded.id, { source: 'unpacked', path: dir, enabled: true }, 'unpacked')
    const known = this.#remember(profile, loaded.id, dir)
    if (known) this.#registerCommands(profile, known)
    this.#deps.changed(profileId)
    return loaded.id
  }

  // ── toolbar actions and popups ──

  #popupFor(win: HostWindow): PopupHost {
    let popup = this.#popups.get(win.id)
    if (!popup) {
      popup = new PopupHost()
      this.#popups.set(win.id, popup)
      win.window.once('closed', () => {
        this.#popups.get(win.id)?.close()
        this.#popups.delete(win.id)
      })
    }
    return popup
  }

  /** The toolbar button's click: opens the popup under `anchor`, or tells the extension it was clicked. */
  runAction(profileId: string, id: string, win: HostWindow, anchor: Bounds): void {
    const { profile, known } = this.#need(profileId, id)
    const rec = profile.store.get(id)
    if (!rec?.enabled || !known.compat.supported) throw new Error(mainT('extensions.error.off'))
    const state = profile.action.get(id) ?? emptyAction()
    const tab = win.tabs().find((t) => t.active) ?? null
    const key: TabKey | null = tab?.id ?? null
    if (!this.#actionEnabled(profile, id, state, key, tab?.url ?? '')) return
    const popup = (key !== null && state.popup.has(key) ? state.popup.get(key) : state.popup.get('all')) ?? actionOf(known.manifest).default_popup ?? ''
    if (popup) {
      this.#popupFor(win).open({
        window: win.window,
        chrome: win.chrome,
        session: profile.session,
        extension: { id, name: known.name },
        url: new URL(popup.replace(/^\/+/, ''), `chrome-extension://${id}/`).href,
        anchor,
        openTab: (url) => void this.#deps.openTab(profileId, url),
        onClosed: () => this.#deps.changed(profileId),
      })
      this.#deps.changed(profileId)
      return
    }
    this.#emitTo(profile, id, 'action.onClicked', tab ? this.#chromeTab(tab) : null)
  }

  /** The anchor a keyboard-run action uses: the top-right corner, under where the toolbar buttons sit. */
  #defaultAnchor(win: HostWindow): Bounds {
    const [width] = win.window.getContentSize()
    return { x: (width ?? 800) - 44, y: 4, width: 32, height: 32 }
  }


  #registerCommands(profile: Profile, known: Known): void {
    this.#unregisterCommands(profile, known.id)
    const disposers: Array<() => void> = []
    const clashes = new Map<string, string | null>()
    for (const cmd of known.commands) {
      if (!cmd.accelerator) continue
      const result = this.#deps.registerShortcut({
        id: `${known.id}:${cmd.name}`,
        owner: known.name,
        title: cmd.description || (cmd.name === EXECUTE_ACTION ? known.name : cmd.name),
        accelerator: cmd.accelerator,
        keys: { mac: cmd.accelerator, other: cmd.accelerator },
        group: 'tools',
        overridesPage: false,
        when: 'any',
      })
      if (result.ok) disposers.push(result.dispose)
      else clashes.set(cmd.name, result.clash)
    }
    profile.shortcuts.set(known.id, disposers)
    profile.clashes.set(known.id, clashes)
  }

  #unregisterCommands(profile: Profile, id: string): void {
    for (const dispose of profile.shortcuts.get(id) ?? []) dispose()
    profile.shortcuts.delete(id)
  }

  /**
   * The input interceptor's question: does this key run an extension command
   * in the window's profile? Runs it and answers true, or answers false.
   */
  handleKey(input: Input, win: HostWindow | null): boolean {
    if (!win) return false
    const pressed = inputAccelerator(input)
    if (!pressed) return false
    const profile = this.#profiles.get(win.profileId)
    if (!profile) return false
    for (const known of profile.known.values()) {
      if (!profile.shortcuts.has(known.id)) continue
      const hit = known.commands.find((c) => c.accelerator && !profile.clashes.get(known.id)?.has(c.name) && normalizeAccelerator(c.accelerator) === pressed)
      if (!hit) continue
      if (hit.name === EXECUTE_ACTION) this.runAction(win.profileId, known.id, win, this.#defaultAnchor(win))
      else {
        const tab = win.tabs().find((t) => t.active)
        this.#emitTo(profile, known.id, 'commands.onCommand', hit.name, tab ? this.#chromeTab(tab) : null)
      }
      return true
    }
    return false
  }

  // ── the shims' calls ──

  #emitTo(profile: Profile, id: string, name: ExtShimEvent, ...args: unknown[]): void {
    const send = (worker: ServiceWorkerMain): void => {
      try {
        worker.send(EXT_SHIM_EVENT, name, ...args)
      } catch (err) {
        log.debug('extensions', 'A worker event was dropped', { id, name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const worker = profile.workers.get(id)
    if (worker && !worker.isDestroyed()) return send(worker)
    if (worker) profile.workers.delete(id)
    // An MV3 worker stops when idle; Chrome wakes it for a click or a command, and so does Atelier.
    const sw = profile.session.serviceWorkers as Partial<Pick<Electron.ServiceWorkers, 'startWorkerForScope'>> | undefined
    if (!sw?.startWorkerForScope || !this.isLoaded(profile.id, id)) return
    sw.startWorkerForScope(`chrome-extension://${id}/`).then(
      (started) => {
        const live = profile.workers.get(id)
        if (live && !live.isDestroyed()) return send(live)
        profile.workers.set(id, started)
        this.#onWorker?.(profile.id, id, started)
        send(started)
      },
      (err: unknown) => log.debug('extensions', 'Could not wake an extension worker', { id, name, error: err instanceof Error ? err.message : String(err) }),
    )
  }

  #watchWorkers(profile: Profile): void {
    const sw = profile.session.serviceWorkers
    sw.on('running-status-changed', ({ versionId, runningStatus }) => {
      // Attach at 'starting': at 'running' the worker's first calls can race the handler.
      if (runningStatus !== 'starting' && runningStatus !== 'running') return
      const worker = sw.getWorkerFromVersionID(versionId)
      const id = worker ? /^chrome-extension:\/\/([a-p]{32})\//.exec(worker.scope)?.[1] : undefined
      if (!worker || !id || profile.workers.get(id) === worker) return
      profile.workers.set(id, worker)
      this.#onWorker?.(profile.id, id, worker)
    })
  }

  /** Set by the shim router: wires a new extension worker's IPC. */
  #onWorker: ((profileId: string, extensionId: string, worker: ServiceWorkerMain) => void) | null = null
  onWorker(fn: (profileId: string, extensionId: string, worker: ServiceWorkerMain) => void): void {
    this.#onWorker = fn
  }

  isLoaded(profileId: string, id: string): boolean {
    const profile = this.#profiles.get(profileId)
    return !!profile && this.#deps.adapter.get(profile.session, id) !== null
  }

  #state(profileId: string, id: string): ActionState {
    const { profile } = this.#need(profileId, id)
    let state = profile.action.get(id)
    if (!state) {
      state = emptyAction()
      profile.action.set(id, state)
    }
    return state
  }

  /** A tab closed: its per-tab badge, title, popup and enabled state go with it. */
  forgetTab(tabId: number): void {
    for (const profile of this.#profiles.values()) {
      for (const state of profile.action.values()) {
        state.badge.delete(tabId)
        state.color.delete(tabId)
        state.title.delete(tabId)
        state.popup.delete(tabId)
        state.disabled.delete(tabId)
      }
    }
  }

  /** chrome.action.* setters and getters from the shims. */
  action(profileId: string, id: string, op: string, details: { tabId?: number; text?: string; color?: unknown; title?: string; popup?: string; path?: unknown }): unknown {
    const state = this.#state(profileId, id)
    const key: TabKey = typeof details.tabId === 'number' ? details.tabId : 'all'
    const get = <T>(map: Map<TabKey, T>): T | undefined => (map.has(key) ? map.get(key) : map.get('all'))
    const set = <T>(map: Map<TabKey, T>, value: T | undefined): void => {
      if (value === undefined || value === '') map.delete(key)
      else map.set(key, value)
      this.#deps.changed(profileId)
    }
    switch (op) {
      case 'action.setBadgeText':
        return set(state.badge, typeof details.text === 'string' ? details.text.slice(0, 16) : undefined)
      case 'action.getBadgeText':
        return get(state.badge) ?? ''
      case 'action.setBadgeBackgroundColor':
        return set(state.color, normalizeBadgeColor(details.color) ?? undefined)
      case 'action.getBadgeBackgroundColor':
        return get(state.color) ?? null
      case 'action.setTitle':
        return set(state.title, typeof details.title === 'string' ? details.title.slice(0, 200) : undefined)
      case 'action.getTitle':
        return get(state.title) ?? actionOf(this.#need(profileId, id).known.manifest).default_title ?? ''
      case 'action.setPopup':
        return set(state.popup, typeof details.popup === 'string' ? details.popup.slice(0, 512) : undefined)
      case 'action.getPopup': {
        const popup = get(state.popup) ?? actionOf(this.#need(profileId, id).known.manifest).default_popup ?? ''
        return popup ? new URL(popup.replace(/^\/+/, ''), `chrome-extension://${id}/`).href : ''
      }
      case 'action.enable':
        state.disabled.delete(key)
        return this.#deps.changed(profileId)
      case 'action.disable':
        state.disabled.add(key)
        return this.#deps.changed(profileId)
      case 'action.isEnabled':
        return !state.disabled.has(key) && !state.disabled.has('all')
      case 'action.setIcon': {
        // Paths only; ImageData icons keep the manifest icon.
        const { known } = this.#need(profileId, id)
        const path = typeof details.path === 'string' ? details.path : details.path && typeof details.path === 'object' ? pickIcon(details.path as Record<string, string>, 32) : null
        if (path) {
          state.icon = iconDataUrl(known.dir, path)
          state.iconPath = path
          this.#deps.changed(profileId)
        }
        return undefined
      }
      default:
        throw new Error(`Unknown action call ${op}.`)
    }
  }

  openPopupFromExtension(profileId: string, id: string): void {
    const win = this.#deps.windows().find((w) => w.profileId === profileId && w.focused)
    if (win) this.runAction(profileId, id, win, this.#defaultAnchor(win))
  }

  /** window.close() from a popup page closes the popup; anywhere else it does what the page does. */
  closeIfPopup(webContents: WebContents): boolean {
    for (const popup of this.#popups.values()) {
      if (popup.webContentsId() === webContents.id) {
        popup.close()
        return true
      }
    }
    return false
  }

  commandsOf(profileId: string, id: string): { name: string; description: string; shortcut: string }[] {
    const { profile, known } = this.#need(profileId, id)
    const clashes = profile.clashes.get(id)
    return known.commands.map((c) => ({ name: c.name, description: c.description, shortcut: c.accelerator && !clashes?.has(c.name) ? c.accelerator : '' }))
  }

  // ── chrome.tabs and chrome.windows (the parts Electron lacks) ──

  #chromeTab(t: HostTab): Record<string, unknown> {
    return {
      id: t.id,
      index: t.index,
      windowId: t.windowId,
      active: t.active,
      highlighted: t.active,
      selected: t.active,
      pinned: t.pinned,
      audible: t.audible,
      mutedInfo: { muted: t.muted },
      discarded: false,
      autoDiscardable: true,
      incognito: false,
      groupId: -1,
      url: t.url,
      title: t.title,
      favIconUrl: t.favicon ?? undefined,
      status: t.loading ? 'loading' : 'complete',
    }
  }

  queryTabs(profileId: string, q: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number; pinned?: boolean; audible?: boolean; url?: string | string[]; title?: string; status?: string }): Record<string, unknown>[] {
    const windows = this.#deps.windows().filter((w) => w.profileId === profileId)
    const focused = windows.find((w) => w.focused) ?? windows[0]
    const urls = q.url === undefined ? null : (Array.isArray(q.url) ? q.url : [q.url]).map(matchPattern)
    const out: Record<string, unknown>[] = []
    for (const w of windows) {
      if ((q.currentWindow || q.lastFocusedWindow) && w !== focused) continue
      // -2 is chrome.windows.WINDOW_ID_CURRENT.
      if (q.windowId !== undefined && q.windowId !== w.id && !(q.windowId === -2 && w === focused)) continue
      for (const t of w.tabs()) {
        if (q.active !== undefined && t.active !== q.active) continue
        if (q.pinned !== undefined && t.pinned !== q.pinned) continue
        if (q.audible !== undefined && t.audible !== q.audible) continue
        if (q.status !== undefined && (t.loading ? 'loading' : 'complete') !== q.status) continue
        if (q.title !== undefined && !globMatch(q.title, t.title)) continue
        if (urls && !urls.some((re) => re.test(t.url))) continue
        out.push(this.#chromeTab(t))
      }
    }
    return out
  }


  /** A shim added a listener for a chrome.tabs event: its worker or page hears that event from now on. */
  listenTabs(profileId: string, caller: ShimCaller, event: ExtListenEvent): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    const wc = caller.webContents
    if (!wc) {
      let events = profile.tabWorkers.get(caller.extensionId)
      if (!events) profile.tabWorkers.set(caller.extensionId, (events = new Set()))
      events.add(event)
    } else {
      const key = caller.frameKey ?? wc
      let page = profile.tabPages.get(key)
      if (!page) {
        page = { extensionId: caller.extensionId, events: new Set(), send: caller.send, alive: caller.alive ?? (() => !wc.isDestroyed()) }
        profile.tabPages.set(key, page)
        wc.once?.('destroyed', () => profile.tabPages.delete(key))
      }
      page.events.add(event)
    }
    if (!profile.tabSnapshot) profile.tabSnapshot = this.#tabsOf(profileId)
  }

  /** A window's tabs changed: one sync on the next turn covers a burst of changes. */
  scheduleTabSync(profileId: string): void {
    const profile = this.#profiles.get(profileId)
    if (!profile || profile.tabSyncTimer) return
    profile.tabSyncTimer = setTimeout(() => {
      profile.tabSyncTimer = null
      this.syncTabs(profileId)
    }, 0)
  }

  /**
   * Compares the profile's tabs with the last sync and sends what changed to
   * the extensions listening: onRemoved, onCreated, onActivated, then
   * onUpdated. Address, title and icon reach only an extension with the tabs
   * permission or access to that site, as in Chrome.
   */
  syncTabs(profileId: string): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    const before = profile.tabSnapshot
    const now = this.#tabsOf(profileId)
    profile.tabSnapshot = now
    if (!before) return
    const windowIds = new Set([...now.values()].map((t) => t.windowId))
    const openWindows = new Set(this.#deps.windows().filter((w) => w.profileId === profileId).map((w) => w.id))
    for (const [id, was] of before) {
      if (now.has(id)) continue
      this.#emitTab(profile, 'tabs.onRemoved', () => [id, { windowId: was.windowId, isWindowClosing: !openWindows.has(was.windowId) || !windowIds.has(was.windowId) }])
    }
    for (const [id, tab] of now) if (!before.has(id)) this.#emitTab(profile, 'tabs.onCreated', (ext) => [this.#tabFor(profileId, ext, tab)])
    for (const [id, tab] of now) {
      const was = before.get(id)
      if (tab.active && (!was || !was.active || was.windowId !== tab.windowId)) this.#emitTab(profile, 'tabs.onActivated', () => [{ tabId: id, windowId: tab.windowId }])
    }
    for (const [id, tab] of now) {
      const was = before.get(id)
      if (!was) continue
      const change = tabChange(was, tab)
      if (!change) continue
      this.#emitTab(profile, 'tabs.onUpdated', (ext) => {
        const seen = this.#seesTab(profileId, ext, tab.url)
        const info = seen ? change : Object.fromEntries(Object.entries(change).filter(([k]) => !PRIVATE_TAB_FIELDS.has(k)))
        return Object.keys(info).length ? [id, info, this.#tabFor(profileId, ext, tab)] : null
      })
    }
  }

  #tabsOf(profileId: string): Map<number, HostTab> {
    const out = new Map<number, HostTab>()
    for (const w of this.#deps.windows()) if (w.profileId === profileId) for (const t of w.tabs()) out.set(t.id, { ...t })
    return out
  }

  /** Sends a tab event to each worker and page listening for it; `args` returns null to skip one extension. */
  #emitTab(profile: Profile, event: ExtListenEvent, args: (extensionId: string) => unknown[] | null): void {
    for (const [id, events] of profile.tabWorkers) {
      if (!events.has(event) || !this.isLoaded(profile.id, id)) continue
      const a = args(id)
      if (a) this.#emitTo(profile, id, event, ...a)
    }
    for (const [key, page] of profile.tabPages) {
      if (!page.alive()) {
        profile.tabPages.delete(key)
        continue
      }
      if (!page.events.has(event)) continue
      const a = args(page.extensionId)
      if (!a) continue
      try {
        page.send(event, ...a)
      } catch (err) {
        log.debug('extensions', 'A page event was dropped', { id: page.extensionId, event, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** Whether an extension may see a tab's address and title: the tabs permission, or access to that site. */
  #seesTab(profileId: string, extensionId: string, url: string): boolean {
    try {
      const granted = this.grantedSet(profileId, extensionId)
      return granted.permissions.includes('tabs') || granted.origins.some((o) => matchPattern(o).test(url))
    } catch {
      return false
    }
  }

  #tabFor(profileId: string, extensionId: string, tab: HostTab): Record<string, unknown> {
    const full = this.#chromeTab(tab)
    if (this.#seesTab(profileId, extensionId, tab.url)) return full
    return Object.fromEntries(Object.entries(full).filter(([k]) => !PRIVATE_TAB_FIELDS.has(k)))
  }

  windowsOf(profileId: string): Record<string, unknown>[] {
    return this.#deps
      .windows()
      .filter((w) => w.profileId === profileId)
      .map((w) => {
        const b = w.window.isDestroyed() ? { x: 0, y: 0, width: 0, height: 0 } : w.window.getBounds()
        return { id: w.id, focused: w.focused, top: b.y, left: b.x, width: b.width, height: b.height, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false }
      })
  }

  createTab(profileId: string, id: string, url: string | undefined, active: boolean): Record<string, unknown> | null {
    const target = url ? new URL(url, `chrome-extension://${id}/`).href : 'about:blank'
    if (!/^(https?|chrome-extension):/i.test(target) && target !== 'about:blank') throw new Error('Tabs can only open web or extension pages.')
    const wcId = this.#deps.openTab(profileId, target, { active })
    if (wcId === null) return null
    const tab = this.#deps
      .windows()
      .flatMap((w) => w.tabs())
      .find((t) => t.id === wcId)
    return tab ? this.#chromeTab(tab) : { id: wcId, url: target, active }
  }

  openOptionsPage(profileId: string, id: string): void {
    const { known } = this.#need(profileId, id)
    const options = (known.manifest as { options_page?: string; options_ui?: { page?: string } }).options_ui?.page ?? (known.manifest as { options_page?: string }).options_page
    if (!options) throw new Error(mainT('extensions.error.noOptions'))
    this.#deps.openTab(profileId, new URL(options.replace(/^\/+/, ''), `chrome-extension://${id}/`).href, { active: true })
  }

  // ── chrome.permissions ──

  #split(ids: string[]): { permissions: string[]; origins: string[] } {
    const isHost = (p: string): boolean => p === '<all_urls>' || p.includes('://')
    return { permissions: ids.filter((p) => !isHost(p)), origins: ids.filter(isHost) }
  }

  grantedSet(profileId: string, id: string): { permissions: string[]; origins: string[] } {
    const { profile, known } = this.#need(profileId, id)
    const lists = permissionLists(known.manifest)
    const granted = this.#split(profile.store.get(id)?.granted ?? [])
    return { permissions: [...new Set([...lists.apis, ...granted.permissions])], origins: [...new Set([...lists.hosts, ...granted.origins])] }
  }

  hasPermissions(profileId: string, id: string, req: { permissions?: string[]; origins?: string[] }): boolean {
    const have = this.grantedSet(profileId, id)
    return (req.permissions ?? []).every((p) => have.permissions.includes(p)) && (req.origins ?? []).every((o) => have.origins.includes(o) || have.origins.includes('<all_urls>'))
  }

  /** chrome.permissions.request: only what the manifest lists as optional, asked again in the prompt (OV-16). */
  async requestPermissions(profileId: string, id: string, req: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
    const { profile, known } = this.#need(profileId, id)
    if (this.hasPermissions(profileId, id, req)) return true
    const lists = permissionLists(known.manifest)
    const optional = new Set([...lists.optionalApis, ...lists.optionalHosts])
    const wanted = [...(req.permissions ?? []), ...(req.origins ?? [])].filter((p) => !this.hasPermissions(profileId, id, this.#split([p])))
    const undeclared = wanted.filter((p) => !optional.has(p))
    if (undeclared.length) throw new Error(`Only permissions specified in the manifest may be requested: ${undeclared.join(', ')}`)
    const split = this.#split(wanted)
    const permissions = [
      ...(split.origins.length ? [{ id: 'hosts', label: hostsPhrase(split.origins) ?? split.origins.join(', ') }] : []),
      ...split.permissions.map((p) => ({ id: p, label: phraseFor(p) ?? p })),
    ]
    const allowed = await this.#deps.askInstall(profileId, { kind: 'optional', name: known.name, icon: known.icon, permissions, optional: [], unsupportedReason: null })
    if (!allowed) return false
    const rec = profile.store.get(id)
    profile.store.upsert(id, { granted: [...(rec?.granted ?? []), ...wanted] })
    this.#emitTo(profile, id, 'permissions.onAdded', split)
    this.#deps.changed(profileId)
    return true
  }

  removePermissions(profileId: string, id: string, req: { permissions?: string[]; origins?: string[] }): boolean {
    const { profile } = this.#need(profileId, id)
    const rec = profile.store.get(id)
    const drop = new Set([...(req.permissions ?? []), ...(req.origins ?? [])])
    const lists = permissionLists(this.#need(profileId, id).known.manifest)
    // Required permissions can't be removed, as in Chrome.
    if ([...drop].some((p) => lists.apis.includes(p) || lists.hosts.includes(p))) throw new Error('You cannot remove required permissions.')
    profile.store.upsert(id, { granted: (rec?.granted ?? []).filter((p) => !drop.has(p)) })
    this.#emitTo(profile, id, 'permissions.onRemoved', this.#split([...drop]))
    this.#deps.changed(profileId)
    return true
  }


  async #nativeAllowed(profileId: string, id: string, hostName: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const { profile, known } = this.#need(profileId, id)
    if (!this.grantedSet(profileId, id).permissions.includes('nativeMessaging')) return { ok: false, error: 'This extension didn’t ask for native messaging.' }
    const found = findHost(hostName, id, this.#deps.nativeHostDirs)
    if (!found.ok) return { ok: false, error: found.reason }
    const key = `${id}:${hostName}`
    if (profile.refused.has(key)) return { ok: false, error: 'Access to the native messaging host was not allowed.' }
    if (profile.store.nativeDecision(id, hostName) !== 'always') {
      const decision = await this.#deps.askNative(profileId, { extensionName: known.name, host: hostName })
      if (decision === 'deny') {
        profile.refused.add(key)
        return { ok: false, error: 'Access to the native messaging host was not allowed.' }
      }
      if (decision === 'always') profile.store.setNativeDecision(id, hostName, 'always')
    }
    return { ok: true, path: found.host.path }
  }

  /** chrome.runtime.connectNative: the port id the shim made up, kept until either side closes it. */
  async nativeConnect(profileId: string, caller: ShimCaller, hostName: string, portId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const { profile } = this.#need(profileId, caller.extensionId)
    const allowed = await this.#nativeAllowed(profileId, caller.extensionId, hostName)
    if (!allowed.ok) return allowed
    const extensionId = caller.extensionId
    const key = `${extensionId}:${portId}:${++this.#portSeq}`
    // Chrome's arguments: the caller's origin, then --parent-window.
    const port = new NativePort(allowed.path, hostArgs(extensionId))
    profile.ports.set(portId, { extensionId, hostName, port, send: caller.send })
    const seen: NativeSeen = { open: true, replied: false, closedWithError: null, launchRefused: false }
    profile.nativeSeen.set(`${extensionId}\n${hostName}`, seen)
    this.#observe({ type: 'native', profileId, extensionId, host: hostName, event: 'open' })
    // The worker stays alive while the port is open, as Chrome keeps it (a worker would otherwise stop when idle).
    const release = caller.keepAlive()
    // A page's ports end with the page, as in Chrome.
    const onGone = (): void => port.disconnect()
    caller.webContents?.once('destroyed', onGone)
    port.on('message', (message) => {
      seen.replied = true
      this.#observe({ type: 'native', profileId, extensionId, host: hostName, event: 'message', message })
      caller.send('native.message', portId, message)
    })
    port.once('disconnect', (error) => {
      if (profile.ports.get(portId)?.port === port) profile.ports.delete(portId)
      seen.open = false
      seen.closedWithError = error
      seen.launchRefused = error !== null && !seen.replied && launchRefused(port.exit)
      release()
      if (caller.webContents && !caller.webContents.isDestroyed()) caller.webContents.off('destroyed', onGone)
      caller.send('native.disconnect', portId, error)
      this.#observe({ type: 'native', profileId, extensionId, host: hostName, event: 'close', error })
      log.debug('extensions', 'A native port closed', { key, error })
    })
    return { ok: true }
  }

  nativePost(profileId: string, extensionId: string, portId: string, message: unknown): void {
    const entry = this.#profiles.get(profileId)?.ports.get(portId)
    if (!entry || entry.extensionId !== extensionId) throw new Error('Attempting to use a disconnected port object')
    entry.port.postMessage(message)
    this.#observe({ type: 'native', profileId, extensionId, host: entry.hostName, event: 'post', message })
  }

  nativeDisconnect(profileId: string, extensionId: string, portId: string): void {
    const profile = this.#profiles.get(profileId)
    const entry = profile?.ports.get(portId)
    if (!entry || entry.extensionId !== extensionId) return
    profile?.ports.delete(portId)
    entry.port.disconnect()
  }

  async nativeSend(profileId: string, extensionId: string, hostName: string, message: unknown): Promise<unknown> {
    const allowed = await this.#nativeAllowed(profileId, extensionId, hostName)
    if (!allowed.ok) throw new Error(allowed.error)
    return sendOnce(allowed.path, hostArgs(extensionId), message)
  }

  /** The last port an extension opened to a host this run, or null. */
  nativeState(profileId: string, extensionId: string, hostName: string): NativeSeen | null {
    const seen = this.#profiles.get(profileId)?.nativeSeen.get(`${extensionId}\n${hostName}`)
    return seen ? { ...seen } : null
  }

  /** Remembers "Always allow" for one host ahead of the first connection (an install the person already confirmed). */
  allowNativeHost(profileId: string, extensionId: string, hostName: string): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) throw new Error(mainT('extensions.error.noProfile'))
    profile.refused.delete(`${extensionId}:${hostName}`)
    profile.store.setNativeDecision(extensionId, hostName, 'always')
  }

  // ── observers ──

  readonly #observers = new Set<(o: HostObservation) => void>()

  /** Watches native ports and browser-setting changes; returns the unwatch. */
  observe(fn: (o: HostObservation) => void): () => void {
    this.#observers.add(fn)
    return () => this.#observers.delete(fn)
  }

  #observe(o: HostObservation): void {
    for (const fn of [...this.#observers]) {
      try {
        fn(o)
      } catch (err) {
        log.debug('extensions', 'An observer failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** The folder an extension runs from (Atelier's copy for store installs). */
  dirOf(profileId: string, id: string): string | null {
    return this.#profiles.get(profileId)?.known.get(id)?.dir ?? null
  }

  /** The file the extension last set as its toolbar icon, or null (the manifest's). */
  actionIconPath(profileId: string, id: string): string | null {
    return this.#profiles.get(profileId)?.action.get(id)?.iconPath ?? null
  }

  /** Stops and starts an extension again (its worker restarts and reconnects). */
  async reload(profileId: string, id: string): Promise<void> {
    const { profile } = this.#need(profileId, id)
    if (!profile.store.get(id)?.enabled) return
    this.#unload(profile, id)
    profile.action.set(id, emptyAction())
    await this.#load(profile, id)
    this.#deps.changed(profileId)
  }

  // ── chrome.privacy (browser settings an extension may hold) ──

  #requirePermission(profileId: string, id: string, permission: string, api = permission): void {
    if (!this.grantedSet(profileId, id).permissions.includes(permission)) throw new Error(`This extension can’t use chrome.${api} without the "${permission}" permission.`)
  }

  /** The running extensions holding a setting. */
  #holds(profile: Profile, key: PrivacyKey): SettingHold[] {
    const out: SettingHold[] = []
    for (const id of profile.store.ids()) {
      const rec = profile.store.get(id)
      if (!rec?.enabled || !rec.settings || !Object.hasOwn(rec.settings, key) || !this.isLoaded(profile.id, id)) continue
      out.push({ extensionId: id, installedAt: rec.installedAt, value: rec.settings[key] })
    }
    return out
  }

  #atelierValue(profileId: string, key: PrivacyKey): boolean {
    try {
      return this.#deps.browserSetting?.(profileId, key) ?? true
    } catch {
      return true
    }
  }

  privacyGet(profileId: string, id: string, key: string): SettingDetails {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'privacy')
    if (!isPrivacyKey(key)) throw new Error(`Unknown setting ${key}.`)
    return settingDetails(key, this.#atelierValue(profileId, key), this.#holds(profile, key), { id, installedAt: profile.store.get(id)?.installedAt ?? 0 })
  }

  privacySet(profileId: string, id: string, key: string, details: { value?: unknown; scope?: unknown }): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'privacy')
    if (!isPrivacyKey(key)) throw new Error(`Unknown setting ${key}.`)
    const refused = checkSet(key, details)
    if (refused) throw new Error(refused)
    // As in Chrome, a lower-precedence extension's value is kept but doesn't take effect while a newer one holds the setting.
    const rec = profile.store.get(id)
    profile.store.upsert(id, { settings: { ...rec?.settings, [key]: details.value } })
    this.#settingChanged(profile, key)
  }

  privacyClear(profileId: string, id: string, key: string, details: { scope?: unknown }): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'privacy')
    if (!isPrivacyKey(key)) throw new Error(`Unknown setting ${key}.`)
    if (details.scope !== undefined && details.scope !== 'regular') throw new Error(`${BRAND_NAME} has no incognito windows, so only the regular scope can be cleared.`)
    const rec = profile.store.get(id)
    if (!rec?.settings || !Object.hasOwn(rec.settings, key)) return
    const settings = { ...rec.settings }
    delete settings[key]
    profile.store.upsert(id, { settings })
    this.#settingChanged(profile, key)
  }

  /** The running extension whose value of a setting is in force, with that value; null when Atelier's own applies. */
  settingController(profileId: string, key: PrivacyKey): { extensionId: string; name: string; value: unknown } | null {
    const profile = this.#profiles.get(profileId)
    if (!profile) return null
    const win = winningHold(this.#holds(profile, key))
    if (!win) return null
    return { extensionId: win.extensionId, name: profile.known.get(win.extensionId)?.name ?? win.extensionId, value: win.value }
  }

  /** The running extension that turned the browser's password saving off, or null: Atelier's own password offers step aside for it. */
  passwordSavingHeldOff(profileId: string): { extensionId: string; name: string } | null {
    const c = this.settingController(profileId, 'services.passwordSavingEnabled')
    return c && c.value === false ? { extensionId: c.extensionId, name: c.name } : null
  }

  /** A setting changed: each extension listening hears its own view of it (ChromeSetting.onChange). */
  #settingChanged(profile: Profile, key: PrivacyKey): void {
    this.#emitTab(profile, 'privacy.onChange', (ext) => {
      try {
        return [key, this.privacyGet(profile.id, ext, key)]
      } catch {
        return null
      }
    })
    this.#observe({ type: 'setting', profileId: profile.id, key })
    this.#deps.changed(profile.id)
  }

  // ── chrome.webNavigation ──

  /** The tab's webContents when it belongs to this profile. */
  #tabContents(profile: Profile, tabId: number): WebContents | null {
    const wc = this.#deps.contents?.(tabId) ?? null
    if (!wc || wc.isDestroyed() || wc.session !== profile.session) return null
    return wc
  }

  navGetFrame(profileId: string, id: string, details: { tabId: number; frameId: number }): Record<string, unknown> | null {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'webNavigation')
    const wc = this.#tabContents(profile, details.tabId)
    if (!wc) return null
    const frame = findFrame(asNavContents(wc), details.frameId)
    if (!frame) return null
    const { errorOccurred, url, parentFrameId, frameType, documentLifecycle } = frameDetails(frame, this.#erroredOf(profile, wc.id).has(details.frameId))
    return { errorOccurred, url, parentFrameId, frameType, documentLifecycle }
  }

  navGetAllFrames(profileId: string, id: string, details: { tabId: number }): Record<string, unknown>[] | null {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'webNavigation')
    const wc = this.#tabContents(profile, details.tabId)
    if (!wc) return null
    return allFrames(asNavContents(wc), this.#erroredOf(profile, wc.id)) as unknown as Record<string, unknown>[]
  }

  #erroredOf(profile: Profile, wcId: number): Set<number> {
    return profile.navWatch.get(wcId)?.errored ?? new Set()
  }

  /** Starts feeding a tab's frame events to chrome.webNavigation listeners; idempotent. */
  watchContents(profileId: string, wc: WebContents): void {
    const profile = this.#profiles.get(profileId)
    if (!profile || wc.isDestroyed() || profile.navWatch.has(wc.id) || wc.session !== profile.session) return
    const errored = new Set<number>()
    const wcId = wc.id
    const emit = (event: ExtNavEvent, details: Record<string, unknown>): void => this.#emitTab(profile, event, (ext) => (this.#hasPermission(profile.id, ext, 'webNavigation') ? [details] : null))
    const unwatch = watchNavigation(asNavContents(wc), emit, (pid, rid) => this.#deps.frameById?.(pid, rid) ?? null, Date.now, errored)
    profile.navWatch.set(wcId, { unwatch, errored })
    wc.once('destroyed', () => {
      profile.navWatch.get(wcId)?.unwatch()
      profile.navWatch.delete(wcId)
    })
  }

  /** A tab's page moved to a new webContents (a prerender or a crashed renderer swapped in). */
  tabReplaced(profileId: string, replacedTabId: number, tabId: number): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    this.#emitTab(profile, 'webNavigation.onTabReplaced', (ext) => (this.#hasPermission(profileId, ext, 'webNavigation') ? [{ replacedTabId, tabId, timeStamp: Date.now() }] : null))
  }

  #hasPermission(profileId: string, id: string, permission: string): boolean {
    try {
      return this.grantedSet(profileId, id).permissions.includes(permission)
    } catch {
      return false
    }
  }

  // ── chrome.windows events ──

  /** windows.onCreated / onRemoved / onFocusChanged, sent to every context listening. */
  windowEvent(profileId: string, event: 'windows.onCreated' | 'windows.onRemoved' | 'windows.onFocusChanged', windowId: number): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    const arg = event === 'windows.onCreated' ? (this.windowsOf(profileId).find((w) => w.id === windowId) ?? { id: windowId, focused: false, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false }) : windowId
    this.#emitTab(profile, event, () => [arg])
  }

  // ── chrome.declarativeContent ──

  #rules(profile: Profile, id: string): ContentRule[] {
    const raw = profile.store.get(id)?.contentRules
    return Array.isArray(raw) ? (raw as ContentRule[]) : []
  }

  contentRulesAdd(profileId: string, id: string, rules: unknown[]): ContentRule[] {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'declarativeContent')
    const before = this.#rules(profile, id)
    const next = addRules(before, rules)
    profile.store.upsert(id, { contentRules: next })
    this.#deps.changed(profileId)
    return next.slice(before.length)
  }

  contentRulesRemove(profileId: string, id: string, ids?: string[]): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'declarativeContent')
    profile.store.upsert(id, { contentRules: removeRules(this.#rules(profile, id), ids) })
    this.#deps.changed(profileId)
  }

  contentRulesGet(profileId: string, id: string, ids?: string[]): ContentRule[] {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'declarativeContent')
    return getRules(this.#rules(profile, id), ids)
  }

  /** The action runs on this tab: not disabled, or disabled by default and shown by a declarativeContent rule (Manifest V3). */
  #actionEnabled(profile: Profile, id: string, state: ActionState, key: TabKey | null, url: string): boolean {
    if (key !== null && state.disabled.has(key)) return false
    if (!state.disabled.has('all')) return true
    return url !== '' && rulesShowAction(this.#rules(profile, id), url)
  }

  // ── chrome.contextMenus ──

  #menus(profile: Profile, id: string): MenuItem[] {
    return restoreItems(profile.store.get(id)?.menus)
  }

  #saveMenus(profile: Profile, id: string, items: MenuItem[]): void {
    profile.store.upsert(id, { menus: items })
  }

  menuCreate(profileId: string, id: string, props: unknown): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'contextMenus')
    this.#saveMenus(profile, id, createItem(this.#menus(profile, id), props))
  }

  menuUpdate(profileId: string, id: string, itemId: unknown, props: unknown): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'contextMenus')
    this.#saveMenus(profile, id, updateItem(this.#menus(profile, id), itemId, props))
  }

  menuRemove(profileId: string, id: string, itemId: unknown): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'contextMenus')
    this.#saveMenus(profile, id, removeItem(this.#menus(profile, id), itemId))
  }

  menuRemoveAll(profileId: string, id: string): void {
    const { profile } = this.#need(profileId, id)
    this.#requirePermission(profileId, id, 'contextMenus')
    this.#saveMenus(profile, id, [])
  }

  /** The running extensions' items for one right-click, for the page menu's extensions section. */
  pageMenu(profileId: string, target: MenuTarget): Array<{ extensionId: string; name: string; icon: string | null; nodes: MenuNode[] }> {
    const profile = this.#profiles.get(profileId)
    if (!profile) return []
    const out: Array<{ extensionId: string; name: string; icon: string | null; nodes: MenuNode[] }> = []
    for (const known of [...profile.known.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!profile.store.get(known.id)?.enabled || !this.isLoaded(profileId, known.id)) continue
      if (!this.#hasPermission(profileId, known.id, 'contextMenus')) continue
      const nodes = visibleTree(this.#menus(profile, known.id), target, (pattern, url) => matchPattern(pattern).test(url))
      if (nodes.length) out.push({ extensionId: known.id, name: known.name, icon: known.icon, nodes })
    }
    return out
  }

  /** A click on one of an extension's items: checkboxes and radios update, then the extension hears onClicked. */
  menuClicked(profileId: string, extensionId: string, itemId: string, target: MenuTarget, tabId: number | null): void {
    const profile = this.#profiles.get(profileId)
    if (!profile) return
    const items = this.#menus(profile, extensionId)
    const item = items.find((i) => i.id === itemId)
    if (!item || !item.enabled) return
    const info = clickData(item, target, item.checked)
    this.#saveMenus(profile, extensionId, afterClick(items, itemId))
    const tab = tabId === null ? null : this.#deps.windows().flatMap((w) => w.tabs()).find((t) => t.id === tabId)
    // The worker may be asleep: registering a listener is what wakes it for clicks, as for every listened event.
    const events = profile.tabWorkers.get(extensionId) ?? new Set<ExtListenEvent>()
    events.add('contextMenus.onClicked')
    profile.tabWorkers.set(extensionId, events)
    this.#emitTab(profile, 'contextMenus.onClicked', (ext) => (ext === extensionId ? [info, tab ? this.#tabFor(profileId, ext, tab) : undefined] : null))
  }


  installedStatus(profileId: string, id: string): 'enabled' | 'disabled' | 'installable' {
    const rec = this.#profiles.get(profileId)?.store.get(id)
    return rec ? (rec.enabled ? 'enabled' : 'disabled') : 'installable'
  }

  /**
   * The store's "Add" click: the install prompt lists what it can do (or
   * the unsupported notice). Resolves with whether the person said yes.
   */
  async beginStoreInstall(profileId: string, id: string, manifestJson: string, localizedName: string, icon: string | null): Promise<{ ok: boolean; unsupported: string | null }> {
    const profile = this.#profiles.get(profileId)
    if (!profile || !EXTENSION_ID.test(id)) return { ok: false, unsupported: null }
    let manifest: Manifest
    try {
      manifest = JSON.parse(manifestJson) as Manifest
    } catch {
      throw new Error('The extension’s manifest is invalid.')
    }
    const compat = classifyCompat(manifest, this.#deps.adapter.apis)
    const perms = describePermissions(manifest)
    const name = localizedName || (manifest.name && !manifest.name.startsWith('__MSG_') ? manifest.name : id)
    const allowed = await this.#deps.askInstall(profileId, { kind: 'install', name, icon, permissions: perms.permissions, optional: perms.optional, unsupportedReason: compat.supported ? null : compat.reason })
    if (!compat.supported) return { ok: false, unsupported: compat.reason }
    if (allowed) profile.approved.add(id)
    return { ok: allowed, unsupported: null }
  }

  /** Installs (or updates) a verified Web Store package for an approved id. */
  async installPackage(profileId: string, id: string, crx: Buffer, opts: { approvedOnly: boolean }): Promise<string> {
    const profile = this.#profiles.get(profileId)
    if (!profile) throw new Error(mainT('extensions.error.noProfile'))
    if (opts.approvedOnly && !profile.approved.has(id)) throw new Error(mainT('extensions.error.notApproved'))
    profile.approved.delete(id)
    const checked = verifyCrx(crx, { expectedId: id, requirePublisher: true })
    const staging = join(profile.dir, `.staging-${id}-${Date.now()}`)
    try {
      unpackArchive(checked.archive, staging)
      writeManifestKey(staging, checked.publicKey)
      applyContentCompat(staging)
      const manifest = readManifest(staging)
      if (!manifest?.version) throw new Error('The extension’s manifest is invalid.')
      const target = join(profile.dir, id, `${manifest.version}_0`)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(join(profile.dir, id), { recursive: true })
      renameSync(staging, target)
      const previous = profile.known.get(id)
      const existing = profile.store.get(id)
      if (previous) this.#unload(profile, id)
      profile.store.upsert(id, { source: 'store', path: null, enabled: existing?.enabled ?? true })
      const known = this.#remember(profile, id, target)
      if (!known) throw new Error('The extension’s manifest is invalid.')
      if (profile.store.get(id)?.enabled) await this.#load(profile, id)
      // Older version folders go once the new one runs.
      if (previous && previous.dir !== target) rmSync(previous.dir, { recursive: true, force: true })
      this.#deps.changed(profileId)
      return known.name
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /** Store-installed extensions and their versions, for the update check. */
  storeInstalls(profileId: string): { id: string; version: string }[] {
    const profile = this.#profiles.get(profileId)
    if (!profile) return []
    return [...profile.known.values()].filter((k) => profile.store.get(k.id)?.source === 'store').map((k) => ({ id: k.id, version: k.version }))
  }

  sessionOf(profileId: string): Session | null {
    return this.#profiles.get(profileId)?.session ?? null
  }

  dispose(): void {
    for (const popup of this.#popups.values()) popup.close()
    for (const profile of this.#profiles.values()) {
      if (profile.tabSyncTimer) clearTimeout(profile.tabSyncTimer)
      profile.tabSyncTimer = null
      for (const entry of profile.ports.values()) entry.port.disconnect()
      profile.ports.clear()
      for (const id of [...profile.shortcuts.keys()]) this.#unregisterCommands(profile, id)
    }
  }
}

/** chrome.tabs fields an extension sees only with the tabs permission or access to the tab's site. */
const PRIVATE_TAB_FIELDS = new Set(['url', 'title', 'favIconUrl', 'pendingUrl'])

/** chrome.tabs.onUpdated's changeInfo between two looks at one tab; null when nothing it reports changed. */
export function tabChange(was: HostTab, now: HostTab): Record<string, unknown> | null {
  const change: Record<string, unknown> = {}
  if (was.loading !== now.loading) change.status = now.loading ? 'loading' : 'complete'
  if (was.url !== now.url) change.url = now.url
  if (was.title !== now.title) change.title = now.title
  if (was.favicon !== now.favicon && now.favicon) change.favIconUrl = now.favicon
  if (was.pinned !== now.pinned) change.pinned = now.pinned
  if (was.audible !== now.audible) change.audible = now.audible
  if (was.muted !== now.muted) change.mutedInfo = { muted: now.muted }
  return Object.keys(change).length ? change : null
}

/** Chrome's id for an unpacked folder: from the manifest's key when it has one, else from the folder's path. */
export function unpackedId(dir: string, manifest: Manifest): string {
  if (typeof manifest.key === 'string' && manifest.key.length > 0) return idFromPublicKey(Buffer.from(manifest.key, 'base64'))
  return idFromPublicKey(Buffer.from(dir, 'utf8'))
}

/** A Chrome match pattern ("*://*.example.com/*", "<all_urls>") as a RegExp. */
export function matchPattern(pattern: string): RegExp {
  if (pattern === '<all_urls>') return /^(https?|wss?|file|ftp):/
  const m = /^(\*|https?|wss?|file|ftp):\/\/(\*|(?:\*\.)?[^/*]*)(\/.*)$/.exec(pattern)
  if (!m) return /$^/
  const [, scheme, host, path] = m
  const esc = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const schemeRe = scheme === '*' ? 'https?' : esc(scheme ?? '')
  const hostRe = host === '*' ? '[^/]*' : host?.startsWith('*.') ? `(?:[^/]*\\.)?${esc(host.slice(2))}` : esc(host ?? '')
  const pathRe = (path ?? '/').split('*').map(esc).join('.*')
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`)
}

function globMatch(glob: string, value: string): boolean {
  const re = new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return re.test(value)
}
