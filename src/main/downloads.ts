/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { copyFile, mkdir, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { BrowserWindow, app, dialog, nativeImage, shell, webContents as allWebContents, type DownloadItem, type NativeImage, type Session, type WebContents } from 'electron'
import type { BetaBrowserStateChange } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { etaSeconds, isClearable, nextSpeed, shouldAutoOpen, type DownloadDanger, type DownloadFolderView, type SpeedSample } from '@shared/downloads'
import type { NotifySpec } from '@shared/notifications'
import type { DownloadInfo } from '@shared/services'
import type { DownloadsServiceAdditions, MenuEvent } from '@shared/services/menus'
import type { DownloadClassifyInput } from '@shared/sites'
import type { AppContext } from './features/types'
import { mainT } from './i18n/mainT'
import { errorMessage, log } from './log'
import { notifications } from './notifications'
import { safety } from './safety'
import { writeAtomic } from './settings'
import { scopedInstance } from './profiles/scope'

const KEEP = 200

/** "report.pdf" → "report (1).pdf" when taken; never leaves the folder. */
export function uniqueFileName(filename: string, taken: (name: string) => boolean): string {
  const safe = basename(filename).replace(/^\.+/, '').trim() || 'download'
  if (!taken(safe)) return safe
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  for (let n = 1; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem}-${randomUUID()}${ext}`
}

/**
 * Where a file's bytes land while it waits for Keep or Discard, or for the
 * save dialog: a hidden name beside it, so moving it into place is a rename.
 */
export function heldFileName(filename: string, id: string): string {
  return `.${filename}.${id.slice(0, 8)}.atelierdownload`
}

// Defaults for the speed, danger and attribution fields
const DOWNLOAD_INFO_DEFAULTS: Pick<DownloadInfo, 'speedBps' | 'etaSeconds' | 'danger' | 'byAgent' | 'mime' | 'tabId'> = {
  speedBps: 0,
  etaSeconds: null,
  danger: 'none',
  byAgent: false,
  mime: '',
  tabId: null,
}

export type DownloadStartedEvent = Extract<MenuEvent, { type: 'download-started' }>

/** Which tab started a download, and whether an agent run did. */
export interface DownloadOrigin {
  tabId: string | null
  byAgent: boolean
  windowId: number | null
}

/** What the manager needs from the rest of the app; Electron's defaults stand in until the feature wires it (and in tests, fakes). */
export interface DownloadDeps {
  prefs(): { downloadDir: string | null; askWhereToSave: boolean }
  setFolder(dir: string | null): void
  origin(source: WebContents | null): DownloadOrigin
  classify(input: DownloadClassifyInput): DownloadDanger
  broadcast(event: DownloadStartedEvent): void
  notify(spec: NotifySpec): void
  /** Whether an Atelier window has focus; finished-download notices only go out when none does. */
  appFocused(): boolean
  saveDialog(windowId: number | null, defaultPath: string): Promise<string | null>
  folderDialog(defaultPath: string): Promise<string | null>
  /** Starts a native drag of the file from the surface the pointer is in. */
  dragOut(path: string): Promise<void>
  /** Resolves with an error message, or '' when the file opened. */
  openPath(path: string): Promise<string>
  reveal(path: string): void
  isDirectory(path: string): boolean
  now(): number
}

/** A small grey square for drags when the system has no icon for the file (macOS refuses an empty one). */
function fallbackDragIcon(): NativeImage {
  return nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0x90), { width: 16, height: 16 })
}

function parentWindow(windowId: number | null): BrowserWindow | null {
  const byId = windowId !== null ? BrowserWindow.fromId(windowId) : null
  return byId ?? BrowserWindow.getFocusedWindow()
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function electronDeps(): DownloadDeps {
  return {
    prefs: () => ({ downloadDir: null, askWhereToSave: false }),
    setFolder: () => {
      throw new Error('Not available yet')
    },
    origin: () => ({ tabId: null, byAgent: false, windowId: null }),
    classify: (input) => safety.classifyDownload(input),
    broadcast: () => undefined,
    notify: (spec) => void notifications.notify(spec),
    appFocused: () => BrowserWindow.getFocusedWindow() !== null,
    saveDialog: async (windowId, defaultPath) => {
      const options = { title: mainT('downloads.dialog.save'), defaultPath }
      const parent = parentWindow(windowId)
      const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    folderDialog: async (defaultPath) => {
      const options = { title: mainT('downloads.dialog.chooseFolder'), buttonLabel: mainT('downloads.dialog.choose'), defaultPath, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const parent = parentWindow(null)
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    dragOut: async (path) => {
      // The drag starts in whichever surface the pointer pressed: the popover or the Downloads page.
      const target = allWebContents.getFocusedWebContents()
      if (!target || target.isDestroyed()) return
      const icon = await app.getFileIcon(path, { size: 'normal' }).catch(() => null)
      target.startDrag({ file: path, icon: icon && !icon.isEmpty() ? icon : fallbackDragIcon() })
    },
    openPath: (path) => shell.openPath(path),
    reveal: (path) => shell.showItemInFolder(path),
    isDirectory,
    now: () => Date.now(),
  }
}

/** Moves a file, copying when the two places are on different volumes. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to)
    await unlink(from)
  }
}

async function removeQuietly(path: string | null): Promise<void> {
  if (!path) return
  try {
    await unlink(path)
  } catch {
    // Already gone.
  }
}

interface Entry {
  info: DownloadInfo
  item: DownloadItem | null
  session: Session | null
  /** Where the bytes are while the file waits for Keep or Discard, or for the save dialog. */
  held: string | null
  /** The save dialog is open: the row stays out of the list until a place is chosen. */
  choosing: boolean
  /** The person picked the place in the save dialog (and agreed to replace a file there). */
  askedWhere: boolean
  meter: SpeedSample | null
  private: boolean
}

let current: DownloadManager | null = null
let pendingDeps: Partial<DownloadDeps> = {}

let profileManagers: ((profileId: string) => DownloadManager | null) | null = null
/** SH-64: a session another profile's manager tracks; the default manager leaves its downloads alone. */
const sessionOwners = new WeakMap<Session, DownloadManager>()

/** Each other profile's own manager, answered inside that profile's scope. */
export function setProfileDownloadManagers(resolve: ((profileId: string) => DownloadManager | null) | null): void {
  profileManagers = resolve
}

/** The app's download manager, once index.ts has made it (inside a profile's scope, that profile's). */
export function downloadManager(): DownloadManager | null {
  return scopedInstance(profileManagers) ?? current
}

/** Wires the manager to settings, tabs, the agent and the chrome; applied now or when the manager is made. */
export function configureDownloads(deps: Partial<DownloadDeps>): void {
  pendingDeps = { ...pendingDeps, ...deps }
  current?.configure(deps)
}

/**
 * Saves downloads to the download folder, tracks progress
 * and speed for the UI, holds flagged files for Keep or Discard,
 * asks where to save when the person wants that (ST-45), and reports start
 * and finish to the agent as browser_state state changes.
 */
export class DownloadManager extends EventEmitter<{ changed: [DownloadInfo[]]; stateChange: [BetaBrowserStateChange] }> {
  readonly #items = new Map<string, Entry>()
  readonly #listPath: string
  readonly #dir: string
  readonly #attached = new WeakSet<Session>()
  readonly #defaultSession: Session
  #deps: DownloadDeps
  #notifyTimer: NodeJS.Timeout | null = null

  /** `profile`: another profile's manager, which owns its session's downloads and never replaces the default one. */
  constructor(session: Session, dataDir: string, downloadsDir: string, deps: Partial<DownloadDeps> = {}, options: { profile?: boolean } = {}) {
    super()
    this.#dir = downloadsDir
    this.#listPath = join(dataDir, 'downloads.json')
    this.#deps = { ...electronDeps(), ...pendingDeps, ...deps }
    this.#defaultSession = session
    this.#load()
    if (options.profile) sessionOwners.set(session, this)
    this.attach(session, false)
    if (!options.profile) current = this
  }

  configure(deps: Partial<DownloadDeps>): void {
    this.#deps = { ...this.#deps, ...deps }
  }

  /** Tracks downloads from a session: the default one, and each private window's. */
  attach(session: Session, isPrivate: boolean): void {
    if (this.#attached.has(session)) return
    this.#attached.add(session)
    session.on('will-download', (_event, item, source) => {
      const owner = sessionOwners.get(session)
      if (owner && owner !== this) return
      this.#track(item, source ?? null, session, isPrivate)
    })
  }

  list(): DownloadInfo[] {
    return [...this.#items.values()]
      .filter((e) => !e.choosing)
      .map((e) => e.info)
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Where new downloads go: the chosen folder, or the default while it is unset or missing. */
  folder(): DownloadFolderView {
    const chosen = this.#deps.prefs().downloadDir
    const missing = chosen !== null && !this.#deps.isDirectory(chosen)
    return { path: chosen !== null && !missing ? chosen : this.#dir, defaultPath: this.#dir, custom: chosen !== null, missing }
  }

  async open(id: string): Promise<void> {
    const entry = this.#require(id)
    const path = this.#finishedPath(entry)
    const error = await this.#deps.openPath(path)
    if (error) throw new Error(error)
  }

  showInFolder(id: string): void {
    this.#deps.reveal(this.#finishedPath(this.#require(id)))
  }

  cancel(id: string): void {
    this.#require(id).item?.cancel()
  }

  /** Clears finished rows; running downloads and files waiting for a decision stay. */
  clear(): void {
    for (const [id, entry] of this.#items) if (!entry.choosing && isClearable(entry.info)) this.#items.delete(id)
    this.#persist()
    this.#notify(true)
  }

  retry(id: string): void {
    const entry = this.#require(id)
    if (entry.info.state === 'progressing' || entry.info.state === 'completed') return
    if (entry.item?.canResume()) {
      entry.item.resume()
      entry.info.state = 'progressing'
      this.#notify(true)
      return
    }
    // An attempt that can't resume starts again, and the new download takes the row's place.
    this.#items.delete(id)
    entry.item?.cancel()
    this.#persist()
    this.#notify(true)
    ;(entry.session ?? this.#defaultSession).downloadURL(entry.info.url)
  }

  /** Takes a row off the list; the file stays where it is. */
  remove(id: string): void {
    const entry = this.#require(id)
    this.#items.delete(id)
    if (entry.item) entry.item.cancel()
    else void removeQuietly(entry.held)
    this.#persist()
    this.#notify(true)
  }

  /** Keeps a file flagged uncommon or dangerous: it moves into place once it has finished. */
  async keep(id: string): Promise<void> {
    const entry = this.#require(id)
    if (entry.info.danger === 'none') return
    entry.info.danger = 'none'
    if (entry.info.state === 'completed' && !entry.choosing) {
      await this.#settle(entry)
      return
    }
    this.#persist()
    this.#notify(true)
  }

  /** Throws a flagged file away (its partial or held bytes too) and takes it off the list. */
  async discard(id: string): Promise<void> {
    const entry = this.#require(id)
    this.#items.delete(id)
    // A running item's done handler sees the row is gone and deletes its bytes.
    if (entry.item) entry.item.cancel()
    else await removeQuietly(entry.held)
    entry.held = null
    this.emit('stateChange', { type: 'download_failed', download_id: id, url: entry.info.url, error: mainT('downloads.agent.discarded') })
    this.#persist()
    this.#notify(true)
  }

  async startDrag(id: string): Promise<void> {
    await this.#deps.dragOut(this.#finishedPath(this.#require(id)))
  }

  async chooseFolder(): Promise<string | null> {
    const picked = await this.#deps.folderDialog(this.folder().path)
    if (!picked) return null
    this.#deps.setFolder(picked)
    return picked
  }

  resetFolder(): void {
    this.#deps.setFolder(null)
  }

  #require(id: string): Entry {
    const entry = this.#items.get(id)
    if (!entry) throw new Error(mainT('downloads.error.unknown'))
    return entry
  }

  /** The path of a finished, kept file that is still there; otherwise says why not. */
  #finishedPath(entry: Entry): string {
    if (entry.info.danger !== 'none') throw new Error(mainT('downloads.error.review'))
    if (entry.info.state !== 'completed' || entry.held || entry.choosing) throw new Error(mainT('downloads.error.notFinished'))
    if (!existsSync(entry.info.path)) throw new Error(mainT('downloads.error.missing'))
    return entry.info.path
  }

  #taken(path: string): boolean {
    if (existsSync(path)) return true
    for (const e of this.#items.values()) if (e.info.path === path && (e.info.state === 'progressing' || e.held !== null)) return true
    return false
  }

  #track(item: DownloadItem, source: WebContents | null, session: Session, isPrivate: boolean): void {
    const deps = this.#deps
    const id = randomUUID()
    const origin = deps.origin(source)
    const dir = this.folder().path
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      log.warn('downloads', 'The download folder could not be made', { error: errorMessage(err) })
    }
    const filename = uniqueFileName(item.getFilename(), (name) => this.#taken(join(dir, name)))
    const path = join(dir, filename)
    const url = item.getURL()
    const mime = item.getMimeType()
    let referrer = ''
    try {
      referrer = source && !source.isDestroyed() ? source.getURL() : ''
    } catch {
      // The page went away while the download started.
    }
    let danger: DownloadDanger = 'none'
    try {
      danger = deps.classify({ url, filename, mime, referrer })
    } catch (err) {
      log.warn('downloads', 'Classifying a download failed', { error: errorMessage(err) })
    }
    // Agent downloads always go straight to the folder (ST-45).
    const ask = deps.prefs().askWhereToSave && !origin.byAgent
    const held = danger !== 'none' || ask ? join(dir, heldFileName(filename, id)) : null
    item.setSavePath(held ?? path)
    const info: DownloadInfo = {
      id,
      url,
      filename,
      path,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: deps.now(),
      ...DOWNLOAD_INFO_DEFAULTS,
      danger,
      byAgent: origin.byAgent,
      mime,
      tabId: origin.tabId,
    }
    const entry: Entry = { info, item, session, held, choosing: ask, askedWhere: false, meter: null, private: isPrivate }
    this.#items.set(id, entry)
    item.on('updated', (_e, state) => this.#progress(entry, state))
    item.once('done', (_e, state) => void this.#done(entry, state))
    if (ask) void this.#choose(entry, origin.windowId)
    else this.#announce(entry)
  }

  /** The row appears: the agent hears of it, and the chrome may open the popover and fly the icon (OV-18, OV-19). */
  #announce(entry: Entry): void {
    const { info } = entry
    this.emit('stateChange', { type: 'download_started', download_id: info.id, url: info.url })
    this.#notify(true)
    const autoOpen = shouldAutoOpen({ byAgent: info.byAgent, askedWhere: entry.askedWhere, totalBytes: info.totalBytes, danger: info.danger })
    this.#deps.broadcast({ type: 'download-started', id: info.id, byAgent: info.byAgent, autoOpen })
  }

  /** The save dialog runs while the bytes already arrive in the held file. */
  async #choose(entry: Entry, windowId: number | null): Promise<void> {
    const chosen = await this.#deps.saveDialog(windowId, entry.info.path).catch((err: unknown) => {
      log.warn('downloads', 'The save dialog failed', { error: errorMessage(err) })
      return null
    })
    if (this.#items.get(entry.info.id) !== entry) return
    entry.choosing = false
    if (!chosen) {
      this.#items.delete(entry.info.id)
      if (entry.item) entry.item.cancel()
      else await removeQuietly(entry.held)
      return
    }
    entry.askedWhere = true
    entry.info.path = chosen
    entry.info.filename = basename(chosen)
    this.#announce(entry)
    if (entry.info.state === 'completed' && entry.info.danger === 'none') await this.#settle(entry)
  }

  #progress(entry: Entry, state: 'progressing' | 'interrupted'): void {
    const { info, item } = entry
    if (!item) return
    info.receivedBytes = item.getReceivedBytes()
    info.totalBytes = item.getTotalBytes()
    if (state === 'interrupted' || item.isPaused()) {
      info.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      info.speedBps = 0
      info.etaSeconds = null
      entry.meter = null
    } else {
      info.state = 'progressing'
      entry.meter = nextSpeed(entry.meter, info.receivedBytes, this.#deps.now())
      info.speedBps = Math.round(entry.meter.bps)
      info.etaSeconds = etaSeconds(info.receivedBytes, info.totalBytes, entry.meter.bps)
    }
    this.#notify(false)
  }

  async #done(entry: Entry, state: 'completed' | 'cancelled' | 'interrupted'): Promise<void> {
    const { info } = entry
    if (entry.item) info.receivedBytes = entry.item.getReceivedBytes()
    entry.item = null
    // Removed or discarded while it ran: only its bytes are left to clean up.
    if (this.#items.get(info.id) !== entry) {
      await removeQuietly(entry.held)
      return
    }
    info.state = state
    info.speedBps = 0
    info.etaSeconds = null
    entry.meter = null
    if (state !== 'completed') {
      await removeQuietly(entry.held)
      entry.held = null
      if (!entry.choosing) this.emit('stateChange', { type: 'download_failed', download_id: info.id, url: info.url, error: state })
    } else if (entry.choosing) {
      // Finished before a place was chosen: #choose moves it.
    } else if (info.danger !== 'none') {
      const danger = mainT(info.danger === 'dangerous' ? 'downloads.agent.dangerous' : 'downloads.agent.uncommon')
      this.emit('stateChange', { type: 'download_failed', download_id: info.id, url: info.url, error: mainT('downloads.agent.held', { danger }) })
      if (!this.#deps.appFocused()) {
        this.#deps.notify({ category: 'downloads', title: mainT('downloads.notify.review'), body: mainT('downloads.notify.reviewBody', { name: info.filename }), target: { url: 'atelier://downloads' } })
      }
    } else {
      await this.#settle(entry)
      return
    }
    this.#persist()
    this.#notify(true)
  }

  /** A finished, kept file: moved into place if it was held, then reported. */
  async #settle(entry: Entry): Promise<void> {
    const { info } = entry
    if (entry.held) {
      try {
        // Someone else may have taken the name meanwhile; a place picked in the save dialog was agreed to.
        if (!entry.askedWhere && existsSync(info.path)) {
          const dir = dirname(info.path)
          info.filename = uniqueFileName(info.filename, (name) => this.#taken(join(dir, name)))
          info.path = join(dir, info.filename)
        }
        await mkdir(dirname(info.path), { recursive: true })
        await moveFile(entry.held, info.path)
        entry.held = null
      } catch (err) {
        log.warn('downloads', 'Moving a finished download into place failed', { error: errorMessage(err) })
        info.state = 'interrupted'
        this.emit('stateChange', { type: 'download_failed', download_id: info.id, url: info.url, error: mainT('downloads.error.move') })
        this.#persist()
        this.#notify(true)
        return
      }
    }
    this.emit('stateChange', { type: 'download_completed', download_id: info.id, url: info.url, path: info.path, size_bytes: info.receivedBytes })
    if (!this.#deps.appFocused()) {
      this.#deps.notify({ category: 'downloads', title: mainT('downloads.notify.done'), body: info.filename, target: { url: 'atelier://downloads', ...(info.tabId ? { tabId: info.tabId } : {}) } })
    }
    this.#persist()
    this.#notify(true)
  }

  #load(): void {
    let saved: unknown
    try {
      saved = JSON.parse(readFileSync(this.#listPath, 'utf8'))
    } catch {
      return // No saved downloads yet.
    }
    if (!Array.isArray(saved)) return
    for (const raw of saved as DownloadInfo[]) {
      if (typeof raw?.id !== 'string') continue
      // Files saved by older versions lack these fields; they get the defaults.
      const info: DownloadInfo = { ...DOWNLOAD_INFO_DEFAULTS, ...raw, speedBps: 0, etaSeconds: null }
      if (info.state === 'progressing') info.state = 'interrupted'
      let held: string | null = null
      if (info.danger !== 'none') {
        const candidate = join(dirname(info.path), heldFileName(basename(info.path), info.id))
        if (info.state === 'completed' && existsSync(candidate)) held = candidate
        else {
          // The held bytes are gone (or never finished): nothing is left to keep.
          if (info.state === 'completed') info.state = 'interrupted'
          try {
            unlinkSync(candidate)
          } catch {
            // Nothing to clean up.
          }
        }
      }
      this.#items.set(info.id, { info, item: null, session: null, held, choosing: false, askedWhere: false, meter: null, private: false })
    }
  }

  #persist(): void {
    const kept = [...this.#items.values()]
      .filter((e) => !e.private && !e.choosing)
      .map((e) => e.info)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, KEEP)
    writeAtomic(this.#listPath, JSON.stringify(kept))
  }

  /** Progress events are frequent; the UI gets at most ~4 updates a second. */
  #notify(now: boolean): void {
    if (now) {
      if (this.#notifyTimer) clearTimeout(this.#notifyTimer)
      this.#notifyTimer = null
      this.emit('changed', this.list())
      return
    }
    this.#notifyTimer ??= setTimeout(() => {
      this.#notifyTimer = null
      this.emit('changed', this.list())
    }, 250)
  }
}

/** Which tab (and window) a download came from, and whether a running agent drove that tab. */
export function downloadOrigin(ctx: Pick<AppContext, 'tabsRegistry' | 'windows' | 'agent'>, source: WebContents | null): DownloadOrigin {
  if (!source || source.isDestroyed()) return { tabId: null, byAgent: false, windowId: null }
  const tab = ctx.tabsRegistry.byWebContents(source.id)
  const win = ctx.windows.fromWebContents(source.id)
  // A tab with no chat id is held by Claude Code outside Atelier (ST-60): that is an agent too.
  const byAgent = tab ? tab.agentControlled && (tab.agentChatId === null || ctx.agent.isRunning(tab.agentChatId)) : false
  return { tabId: tab?.id ?? null, byAgent, windowId: win?.id ?? null }
}

function manager(): DownloadManager {
  const found = downloadManager()
  if (!found) throw new Error('Not available yet')
  return found
}

/** The downloads service methods, served by the app's manager. */
export const DOWNLOADS_SERVICE: DownloadsServiceAdditions = {
  retry: (id) => manager().retry(id),
  remove: (id) => manager().remove(id),
  keep: (id) => manager().keep(id),
  discard: (id) => manager().discard(id),
  startDrag: (id) => manager().startDrag(id),
  chooseFolder: () => manager().chooseFolder(),
  resetFolder: () => manager().resetFolder(),
  folder: () => manager().folder(),
}

/** The menus feature's app hook: settings, tab attribution and the chrome's events. Reads nothing until a download starts. */
export function wireDownloads(ctx: AppContext): DownloadsServiceAdditions {
  configureDownloads({
    prefs: () => {
      const s = ctx.settings.get()
      return { downloadDir: s.downloadDir, askWhereToSave: s.askWhereToSave }
    },
    setFolder: (downloadDir) => {
      ctx.settings.update({ downloadDir })
    },
    origin: (source) => downloadOrigin(ctx, source),
    broadcast: (event) => ctx.broadcast(event),
  })
  return DOWNLOADS_SERVICE
}

/** The menus feature's session hook: private windows' downloads show up too, but are never saved to the list file. */
export function attachDownloads(session: Session, isPrivate: boolean): void {
  current?.attach(session, isPrivate)
}
