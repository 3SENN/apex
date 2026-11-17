/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { BrowserWindow, Notification, app, nativeTheme, shell } from 'electron'
import { BRAND_NAME } from '@shared/branding'
import { UI, type Settings } from '@shared/ipc'
import { applyContributions, menus, type MenuItemModel, type MenuState } from '@shared/menuModel'
import type { MeetingRecorder } from '@shared/meetingCapture'
import type { AttentionState } from '@shared/notifications'
import type { AppEvent } from '@shared/services'
import type { CommandId } from '@shared/shortcuts'
import { APP_USER_MODEL_ID, type BackgroundDecision, type LoginItemState, type OsPlatform, type SystemServices } from '@shared/system'
import type { UpdatesServices } from '@shared/updates'
import type { CommandRegistry } from '../commands'
import type { AttentionFeed, RoutineRunInfo } from '../features/maintenanceRuntime'
import type { WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import type { SettingsStore } from '../settings'
import type { WindowManager } from '../windows'
import { LinuxAutostart, autostartDir } from './autostartLinux'
import { backgroundMode, backgroundPolicy, keepsRunning } from './background'
import { linuxTrayAvailable, probeStatusNotifier } from './linuxTray'
import { ElectronLoginItem, FakeLoginItem, unpackagedLoginItem, type LoginItemBackend } from './loginItem'
import { firstLaunchEvents, linkWindow, parseLaunchArgs, type LaunchTargets } from './secondInstance'
import { SystemState } from './state'
import { Taskbar } from './taskbar'
import { recolourTitleBar } from './titleBar'
import { TRAY_IDS, TrayIcon, trayMenuItems, type TrayStatus } from './tray'

// The system service and runtime: background mode, the tray, the login
// item, the taskbar, second launches and the Windows and Linux title bar.
// setupSystem builds lazily, so the contract tests can call it without
// Electron; the feature calls runtime.start() inside the app.

export interface SystemDeps {
  settings: SettingsStore
  /** The next routine run, for the tray's status line. */
  routines: RoutineRunInfo
  /** The MeetingRecorder (ctx.personal.recorder): "Recording a meeting", with Stop. */
  meetings: MeetingRecorder
  /** The WindowManager: Open Apex, New Window, and the window count for backgroundPolicy. */
  windows: WindowManager
  /** Unread and needs-you counts for the tray and the taskbar. */
  attention: AttentionFeed
  // Optional, so the older call shape still builds
  /** The command registry: New Window, New Chat and Quit go through it (Quit asks first when the settings say so). */
  commands?: CommandRegistry
  broadcast?(event: AppEvent): void
  /** The updates service (ctx.maintenance.updates), read lazily: the tray's Restart to Update. */
  updates?(): UpdatesServices['updates'] | null
  dataDir?: string
  smoke?: boolean
}

const LOGIN_ITEMS_URL: Partial<Record<OsPlatform, string>> = {
  darwin: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  win32: 'ms-settings:startupapps',
}

/** A quit still under way after this long was cancelled by a window that stayed open. */
const QUIT_SETTLE_MS = 2000

/** The tray's routine line goes stale by the minute. */
const TRAY_REFRESH_MS = 60_000

export class SystemRuntime {
  readonly #deps: SystemDeps
  readonly platform: OsPlatform
  #backend: LoginItemBackend | null = null
  #autostart: LinuxAutostart | null = null
  #loginState: LoginItemState | null = null
  #tray: TrayIcon | null = null
  #taskbar: Taskbar | null = null
  #state: SystemState | null = null
  #trayLinux: boolean | null = null
  #quitting = false
  #quitAt = 0
  #dockHidden = false
  #attention: AttentionState = { unread: 0, needsYou: 0 }
  #timer: NodeJS.Timeout | null = null
  #recheckAt = 0
  #offs: Array<() => void> = []
  /** Smoke reads these instead of watching the OS. */
  readonly record = { notices: 0, relaunches: 0, opened: [] as string[] }

  constructor(deps: SystemDeps, platform: OsPlatform = process.platform) {
    this.#deps = deps
    this.platform = platform
  }

  // ---- the service ----

  get services(): SystemServices {
    return {
      system: {
        loginItem: () => this.loginItem(),
        setOpenAtLogin: (on) => this.setOpenAtLogin(on),
        openLoginItemsSettings: () => this.openLoginItemsSettings(),
        setTaskbarOverlay: (kind, png, description) => this.taskbar().setImage(kind, png, description),
        trayAvailable: () => this.trayAvailable(),
      },
    }
  }

  backend(): LoginItemBackend {
    if (this.#backend) return this.#backend
    if (this.#deps.smoke) this.#backend = new FakeLoginItem()
    else if (!app.isPackaged) this.#backend = unpackagedLoginItem
    else {
      // An AppImage runs from a temporary mount; $APPIMAGE is the file the person keeps.
      const launcher = process.env.APPIMAGE || process.execPath
      if (this.platform === 'linux') this.#autostart = new LinuxAutostart({ dir: autostartDir(process.env, homedir()), entry: { launcher, name: BRAND_NAME, comment: mainT('system.general.openAtLogin.description') } })
      this.#backend = new ElectronLoginItem({ platform: this.platform, linux: this.#autostart, argv: process.argv })
    }
    return this.#backend
  }

  loginItem(): LoginItemState {
    const state = this.backend().read()
    this.#noteLoginItem(state)
    return state
  }

  setOpenAtLogin(on: boolean): LoginItemState {
    const state = this.backend().write(on)
    log.info('system', 'Open at login changed', { on, status: state.status })
    this.#noteLoginItem(state, true)
    return state
  }

  openLoginItemsSettings(): void {
    const url = LOGIN_ITEMS_URL[this.platform]
    if (!url) throw new Error(mainT('system.general.openAtLogin.unpackaged'))
    // Smoke never leaves Apex; it checks the request instead.
    if (this.#deps.smoke) {
      this.record.opened.push(url)
      return
    }
    void shell.openExternal(url).catch((err: unknown) => log.warn('system', 'Login Items settings did not open', { error: String(err) }))
  }

  trayAvailable(): boolean {
    if (this.platform === 'darwin' || this.platform === 'win32') return true
    if (this.platform !== 'linux') return false
    return this.#trayLinux ?? linuxTrayAvailable({ watcher: null, desktop: process.env.XDG_CURRENT_DESKTOP ?? '' })
  }

  taskbar(): Taskbar {
    this.#taskbar ??= new Taskbar({ platform: this.platform, windows: () => this.#appWindows().map((w) => w.window) })
    return this.#taskbar
  }

  // ---- background mode ----

  /** The setting, and on Linux a tray to stay in. */
  runInBackground(): boolean {
    return this.#deps.settings.get().runInBackground && this.trayAvailable()
  }

  decide(o: { openedAtLogin: boolean }): BackgroundDecision {
    return backgroundPolicy({ platform: this.platform, runInBackground: this.runInBackground(), windowCount: this.#visibleWindows().length, quitting: this.#quitting, openedAtLogin: o.openedAtLogin })
  }

  /** The last window closed. True when Apex keeps running; false and the caller quits. */
  windowAllClosed(): boolean {
    const decision = this.decide({ openedAtLogin: false })
    log.info('system', 'Last window closed', { decision })
    if (decision === 'quit') return false
    if (keepsRunning(decision)) this.#enterBackground(decision, true)
    return true
  }

  /** Asked when the first window is ready: a launch at login in background mode stays hidden. */
  startHidden(): boolean {
    let opened = false
    try {
      opened = this.backend().openedAtLogin()
    } catch {
      opened = false
    }
    const decision = this.decide({ openedAtLogin: opened })
    if (!opened || !keepsRunning(decision)) return false
    log.info('system', 'Started at login in the background', { decision })
    this.#enterBackground(decision, false)
    return true
  }

  get dockHidden(): boolean {
    return this.#dockHidden
  }

  get trayShown(): boolean {
    return this.#tray?.shown ?? false
  }

  #enterBackground(decision: BackgroundDecision, notice: boolean): void {
    this.syncTray()
    if (decision === 'hide-dock' && this.platform === 'darwin' && !this.#dockHidden) {
      app.dock?.hide()
      this.#dockHidden = true
    }
    if (notice) this.#stillRunningNotice()
  }

  /** The one-time "still running" notice, the first time Apex stays in the background. */
  #stillRunningNotice(): void {
    const state = this.#systemState()
    if (state.backgroundNoticeShown) return
    state.markBackgroundNoticeShown()
    this.record.notices++
    if (this.#deps.smoke || !Notification.isSupported()) return
    const body = mainT(this.platform === 'darwin' ? 'system.background.stillRunning.mac' : this.platform === 'win32' ? 'system.background.stillRunning.win' : 'system.background.stillRunning.linux')
    const note = new Notification({ title: mainT('system.background.stillRunning.title'), body, silent: true })
    note.on('click', () => void this.openApex())
    note.show()
  }

  async #showDock(): Promise<void> {
    if (!this.#dockHidden) return
    this.#dockHidden = false
    // The Dock icon comes back before the window, or macOS can leave it unfocused.
    await app.dock?.show().catch(() => undefined)
  }

  /** Open Apex: the existing window (hidden ones too), else the last closed one, else a new one. */
  async openApex(): Promise<WindowContext | null> {
    await this.#showDock()
    const existing = this.#appWindows()
    const win = this.#deps.windows.focused() ?? existing[0] ?? null
    if (win && !win.window.isDestroyed()) {
      if (win.window.isMinimized()) win.window.restore()
      win.window.show()
      win.window.focus()
      if (this.platform === 'darwin') app.focus({ steal: true })
      return win
    }
    try {
      const closed = this.#deps.windows.recentlyClosed().findIndex((e) => e.kind === 'window')
      if (!(closed >= 0 && this.#deps.windows.reopen(closed))) this.#deps.windows.open('normal')
      return this.#deps.windows.focused()
    } catch (err) {
      // Before multi-window lands there is no way to make a window again: start afresh.
      log.warn('system', 'No window could be opened; relaunching', { error: err instanceof Error ? err.message : String(err) })
      this.record.relaunches++
      if (!this.#deps.smoke) {
        app.relaunch()
        app.exit(0)
      }
      return null
    }
  }

  // ---- the tray ----

  syncTray(): void {
    const want = this.runInBackground()
    if (want && !this.#tray?.shown) {
      this.#tray ??= new TrayIcon({ platform: this.platform, onClick: () => void this.openApex() })
      this.#tray.show()
      this.#timer = setInterval(() => this.renderTray(), TRAY_REFRESH_MS)
      this.#timer.unref?.()
      this.renderTray()
    } else if (!want && this.#tray?.shown) {
      this.#tray.hide()
      if (this.#timer) clearInterval(this.#timer)
      this.#timer = null
    }
  }

  trayStatus(): TrayStatus {
    let recording: TrayStatus['recording'] = 'none'
    try {
      const state = this.#deps.meetings.status().state
      recording = state === 'paused' ? 'paused' : state === 'recording' || state === 'starting' ? 'recording' : 'none'
    } catch {
      // The recorder isn't there yet.
    }
    let nextRunAt: number | null = null
    try {
      nextRunAt = this.#deps.routines.nextRunAt()
    } catch {
      nextRunAt = null
    }
    let updateReady = false
    try {
      updateReady = this.#deps.updates?.()?.status().phase === 'ready'
    } catch {
      updateReady = false
    }
    return { recording, nextRunAt, needsYou: this.#attention.needsYou, updateReady }
  }

  /** What the system:tray contribution builds. */
  trayItems(): MenuItemModel[] {
    return trayMenuItems(this.trayStatus(), Date.now(), mainT)
  }

  /** The tray's menu: every 'tray' contribution (this module's first), rebuilt on demand. */
  renderTray(): void {
    if (!this.#tray?.shown) return
    const items = applyContributions('tray', [], this.#menuState())
    const tooltip = this.#attention.needsYou > 0 ? mainT('system.tray.tooltip.needsYou', { count: this.#attention.needsYou }) : mainT('system.tray.tooltip')
    this.#tray.render(items, tooltip, (item) => void this.runTrayItem(item))
  }

  async runTrayItem(item: Pick<MenuItemModel, 'id' | 'commandId'>): Promise<void> {
    switch (item.id) {
      case TRAY_IDS.open:
      case TRAY_IDS.needsYou:
        await this.openApex()
        return
      case TRAY_IDS.newWindow: {
        await this.#showDock()
        if (!(await this.#command('new-window'))) {
          try {
            this.#deps.windows.open('normal')
          } catch {
            await this.openApex()
          }
        }
        return
      }
      case TRAY_IDS.newChat: {
        const win = await this.openApex()
        // The chrome takes New Chat as a menu command until the command is registered.
        if (!(await this.#command('new-chat')) && win && !win.chrome.isDestroyed()) win.chrome.send(UI.command, 'new-chat')
        return
      }
      case TRAY_IDS.stopRecording:
        await this.#deps.meetings.stop().catch((err: unknown) => log.warn('system', 'The recording did not stop', { error: String(err) }))
        return
      case TRAY_IDS.update:
        this.#deps.updates?.()?.install()
        return
      case TRAY_IDS.quit:
        // The Quit command asks first when warn-before-quitting is on; ⌘Q and this both really quit.
        if (!(await this.#command('quit'))) app.quit()
        return
      default:
        if (item.commandId) await this.#command(item.commandId)
    }
  }

  async #command(id: CommandId): Promise<boolean> {
    const commands = this.#deps.commands
    if (!commands?.has(id)) return false
    return commands.run(id, this.#deps.windows.focused())
  }

  #menuState(): MenuState {
    const focused = this.#deps.windows.focused()
    return {
      windows: this.#deps.windows.list(),
      focusedWindow: focused ? { id: focused.id, kind: focused.kind } : null,
      tabs: [],
      activeTabId: null,
      focusedSurface: null,
      commands: {},
      update: { state: 'idle', percent: null },
    }
  }

  // ---- second launches ----

  handleLaunch(targets: LaunchTargets): void {
    // A login launch meeting a running Apex changes nothing.
    if (targets.urls.length === 0 && targets.companionFiles.length === 0) {
      if (!targets.background) void this.openApex()
      return
    }
    void this.openApex().then(() => {
      // Outside links never land in a private or chat window (the window manager's rule for open-url).
      const urls = [...targets.urls]
      let target = linkWindow(this.#deps.windows.focused(), this.#appWindows())
      if (!target && urls.length > 0) {
        try {
          this.#deps.windows.open('normal', { url: urls.shift() })
        } catch (err) {
          log.warn('system', 'No window for the opened links', { error: err instanceof Error ? err.message : String(err) })
        }
        target = linkWindow(this.#deps.windows.focused(), this.#appWindows())
      }
      if (target && urls.length > 0) {
        for (const url of urls) target.tabs.create(url)
        if (!target.window.isDestroyed()) {
          target.window.show()
          target.window.focus()
        }
      }
      // The app's open-file handler shows the companion import review.
      for (const path of targets.companionFiles) app.emit('open-file', { preventDefault: () => undefined }, path)
    })
  }

  /** Windows and Linux: a cold start's links and files, through the events start-up already queues. */
  #firstLaunch(): void {
    if (this.platform !== 'win32' && this.platform !== 'linux') return
    if (this.#deps.smoke || !app.isPackaged) return
    for (const { event, value } of firstLaunchEvents(parseLaunchArgs(process.argv, { cwd: process.cwd(), platform: this.platform, isFile }))) {
      app.emit(event, { preventDefault: () => undefined }, value)
    }
  }

  // ---- start and stop ----

  start(): void {
    if (this.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
    backgroundMode.install({ windowAllClosed: () => this.windowAllClosed(), startHidden: () => this.startHidden() })

    const on = <A extends unknown[]>(event: string, fn: (...args: A) => void): void => {
      app.on(event as 'ready', fn as never)
      this.#offs.push(() => app.off(event as 'ready', fn as never))
    }
    on('before-quit', (event: Electron.Event) => {
      // CH-30: a quit held to ask about a private chat isn't happening (yet).
      if (event.defaultPrevented) return
      this.#quitting = true
      this.#quitAt = Date.now()
    })
    on('activate', (_e: unknown, hasVisibleWindows: boolean) => {
      if (!hasVisibleWindows && this.#visibleWindows().length === 0) void this.openApex()
    })
    on('second-instance', (_e: unknown, argv: string[], cwd: string) => {
      this.handleLaunch(parseLaunchArgs(argv, { cwd, platform: this.platform, isFile: isFile }))
    })
    on('browser-window-focus', (_e: unknown, win: BrowserWindow) => {
      // A window kept open (a close it asked about, then cancelled) cancels the quit; background mode applies again.
      if (this.#quitting && Date.now() - this.#quitAt > QUIT_SETTLE_MS) this.#quitting = false
      this.taskbar().windowFocused(win)
      this.#recheckLoginItem()
    })
    on('browser-window-created', (_e: unknown, win: BrowserWindow) => {
      // Floats and overlay children are windows too; only Apex's own windows bring the Dock back.
      win.once('show', () => {
        if (!this.#appWindows().some((w) => w.window === win)) return
        void this.#showDock()
        this.taskbar().windowAdded()
        recolourTitleBar(win, this.#look())
      })
    })

    const onSettings = (next: Settings, previous: Settings): void => {
      if (next.runInBackground !== previous.runInBackground) this.syncTray()
      if (next.layout !== previous.layout || next.profileHue !== previous.profileHue || next.theme !== previous.theme) this.#recolourAll()
    }
    this.#deps.settings.on('changed', onSettings)
    this.#offs.push(() => this.#deps.settings.off('changed', onSettings))
    const onTheme = (): void => this.#recolourAll()
    nativeTheme.on('updated', onTheme)
    this.#offs.push(() => nativeTheme.off('updated', onTheme))

    try {
      this.#offs.push(this.#deps.attention.onChange((s) => {
        this.#attention = { ...s }
        this.taskbar().setAttention(s)
        this.renderTray()
      }))
    } catch (err) {
      log.warn('system', 'Attention counts are not available yet', { error: String(err) })
    }
    try {
      this.#deps.meetings.on('status', () => this.renderTray())
    } catch {
      // The recorder isn't there yet; the minute refresh still updates the tray.
    }
    this.#offs.push(menus.onInvalidate(() => this.renderTray()))

    if (this.platform === 'linux') {
      void probeStatusNotifier().then((watcher) => {
        this.#trayLinux = linuxTrayAvailable({ watcher, desktop: process.env.XDG_CURRENT_DESKTOP ?? '' })
        this.syncTray()
      })
      this.backend()
      // A moved AppImage leaves a stale autostart entry behind.
      try {
        this.#autostart?.refresh()
      } catch {
        // A read-only home: the entry stays as it was.
      }
    }
    this.#recolourAll()
    this.syncTray()
    this.#firstLaunch()
  }

  stop(): void {
    for (const off of this.#offs.splice(0)) off()
    backgroundMode.install(null)
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#tray?.hide()
  }

  // ---- helpers ----

  #appWindows(): WindowContext[] {
    try {
      return this.#deps.windows.all().filter((w) => !w.window.isDestroyed())
    } catch {
      return []
    }
  }

  #visibleWindows(): WindowContext[] {
    return this.#appWindows().filter((w) => w.window.isVisible())
  }

  #systemState(): SystemState {
    this.#state ??= new SystemState(this.#deps.dataDir ?? app.getPath('userData'))
    return this.#state
  }

  #noteLoginItem(state: LoginItemState, force = false): void {
    const before = this.#loginState
    this.#loginState = state
    if (force || !before || before.status !== state.status || before.openAtLogin !== state.openAtLogin) this.#deps.broadcast?.({ type: 'login-item', state })
  }

  /** Back from System Settings: the approval may have changed. */
  #recheckLoginItem(): void {
    const now = Date.now()
    if (now - this.#recheckAt < 1000 || !this.#loginState) return
    this.#recheckAt = now
    try {
      this.loginItem()
    } catch (err) {
      log.warn('system', 'The login item could not be read', { error: String(err) })
    }
  }

  #look(): { mode: 'light' | 'dark'; layout: Settings['layout']; hue: Settings['profileHue'] } {
    const s = this.#deps.settings.get()
    return { mode: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', layout: s.layout, hue: s.profileHue }
  }

  #recolourAll(): void {
    if (this.platform !== 'win32' && this.platform !== 'linux') return
    const look = this.#look()
    for (const w of this.#appWindows()) recolourTitleBar(w.window, look)
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

let current: SystemRuntime | null = null

/** The running system runtime, for smoke. */
export function currentSystemRuntime(): SystemRuntime | null {
  return current
}

export function setupSystem(deps: SystemDeps): { services: SystemServices; runtime: SystemRuntime } {
  const runtime = new SystemRuntime(deps)
  current = runtime
  return { services: runtime.services, runtime }
}
