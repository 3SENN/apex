/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Session, WebContents } from 'electron'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import { WEB_STORE_URL, storeSupportUrl, type ExtensionInstallPrompt, type ExtensionNativePrompt, type ExtensionsEvent, type ExtensionsServices } from '@shared/extensions'
import { signedAsBrowser } from '../codeSignature'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import type { RegisterRuntimeResult, RuntimeShortcut } from '../shortcuts'
import { nativeAdapter, type ExtensionsAdapter } from './adapter'
import { createApplePasswords } from './applePasswords'
import { APPLE_PASSWORDS_EXTENSION_ID, type ApplePasswordsStatus } from '@shared/applePasswords'
import type { PrivacyKey } from './privacySettings'
import type { NavFrame } from './webNavigation'
import { ExtensionsHost as Host, type HostWindow } from './host'
import { wireFrames, wireWorker } from './shim'
import { checkForUpdates, downloadCrx, wireWebStore } from './webStore'

// Extensions: Electron's own session.extensions behind a small adapter
// (the extensions library waits for its two-week version pin), Web Store
// installs through Apex's own verified bridge, toolbar actions and popups,
// permissions, manifest commands and native messaging. This module is the service face: it routes calls to the
// asking window's profile and turns the host's questions into prompts.

/** Runs per profile session through Feature.session (profiles.onSessionCreated). */
export interface ExtensionsHost {
  attach(session: Session, profileId: string): void
  detach(profileId: string): Promise<void>
  /** The running extension that turned password saving off through chrome.privacy (Apple Passwords, say), or null. */
  passwordSavingHeldOff?(profileId: string): { extensionId: string; name: string } | null
}

/** A window as the service sees it: the host's view plus a way to send it events. */
export interface ServiceWindow extends HostWindow {
  send(event: ExtensionsEvent): void
}

export interface ExtensionsDeps {
  dataDir: string
  broadcast(event: ExtensionsEvent): void
  // All optional, so contract tests can build it from dataDir and broadcast alone
  windows?(): ServiceWindow[]
  /** The profile of the window that asked (the profiles feature's profileOf); the default profile until then. */
  currentProfile?(): string
  openTab?(profileId: string, url: string, opts?: { active?: boolean }): number | null
  toast?(profileId: string, kind: 'success' | 'error' | 'info', text: string): void
  confirmRemove?(profileId: string, name: string): Promise<boolean>
  /** Built preload paths; null keeps IPC and preloads off (unit tests). */
  preloads?: { worker: string; frame: string } | null
  nativeHostDirs?: string[]
  extensionsDir?(profileId: string): string
  registerShortcut?(def: RuntimeShortcut): RegisterRuntimeResult
  clashesWith?(accelerator: string): string | null
  chromeVersion?: string
  /** Smoke and tests: no update checks, nothing leaves the machine. */
  offline?: boolean
  adapter?: ExtensionsAdapter
  /** After each list change has gone out (menus rebuild here). */
  onChanged?(profileId: string): void
  /** A tab's webContents by id, and a frame by process and routing ids (chrome.webNavigation). */
  contents?(tabId: number): WebContents | null
  frameById?(processId: number, routingId: number): NavFrame | null
  /** Apex's own value for a browser setting extensions read through chrome.privacy. */
  browserSetting?(profileId: string, key: PrivacyKey): boolean
  /** settings.autofill.yieldToPasswordExtension. */
  yieldToPasswordExtension?(): boolean
  /** Apple Passwords is offered on macOS only. */
  mac?: boolean
}

/** Smoke-only seams: answer install prompts (instead of showing them), hand over a local package instead of the Web Store's, and open the popup in a smoke window. */
export const extensionsSmoke = {
  installPrompt: null as ((prompt: ExtensionInstallPrompt) => void) | null,
  fetchAppleCrx: null as ((profileId: string) => Promise<Buffer>) | null,
  openApplePopup: null as ((profileId: string) => void) | null,
}

export interface Extensions {
  services: ExtensionsServices
  host: Host
  /** Apple Passwords' status and switches, per profile (the services answer for the asking window's profile). */
  apple: ReturnType<typeof createApplePasswords>
  dispose(): void | Promise<void>
}

/** How long a prompt waits for an answer before it counts as a no. */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000
/** Badge updates can come in bursts; the list goes out once per beat. */
const EMIT_DEBOUNCE_MS = 40
const UPDATE_FIRST_MS = 60 * 1000
const UPDATE_EVERY_MS = 5 * 60 * 60 * 1000

/** The default profile's extensions live in userData/Extensions; others in profiles/<id>/Extensions. */
export function extensionsDirFor(dataDir: string, profileId: string): string {
  return profileId === DEFAULT_PROFILE_ID ? join(dataDir, 'Extensions') : join(dataDir, 'profiles', profileId, 'Extensions')
}

/** The live instance, for smoke checks (src/main/smokeFilesConnectors/extensions.ts). */
let current: Extensions | null = null
export function currentExtensions(): Extensions | null {
  return current
}

export function setupExtensions(deps: ExtensionsDeps): Extensions {
  const windows = (): ServiceWindow[] => deps.windows?.() ?? []
  const profileNow = (): string => deps.currentProfile?.() ?? DEFAULT_PROFILE_ID
  const toast = (profileId: string, kind: 'success' | 'error' | 'info', text: string): void => deps.toast?.(profileId, kind, text)

  const pendingInstall = new Map<string, { resolve(allow: boolean): void; timer: NodeJS.Timeout }>()
  const pendingNative = new Map<string, { resolve(decision: 'once' | 'always' | 'deny'): void; timer: NodeJS.Timeout }>()

  /** Prompts go to the profile's focused window (one answer), or every window when none is known. */
  const sendToProfile = (profileId: string, event: ExtensionsEvent, onlyFocused: boolean): void => {
    const mine = windows().filter((w) => w.profileId === profileId)
    if (mine.length === 0) return deps.broadcast(event)
    const targets = onlyFocused ? [mine.find((w) => w.focused) ?? mine[0]] : mine
    for (const w of targets) w?.send(event)
  }

  const timers = new Map<string, NodeJS.Timeout>()
  const changed = (profileId: string): void => {
    if (timers.has(profileId)) return
    timers.set(
      profileId,
      setTimeout(() => {
        timers.delete(profileId)
        sendToProfile(profileId, { type: 'extensions', items: host.list(profileId) }, false)
        apple.notify(profileId)
        deps.onChanged?.(profileId)
      }, EMIT_DEBOUNCE_MS),
    )
  }

  const askInstall = (profileId: string, prompt: Omit<ExtensionInstallPrompt, 'id'>): Promise<boolean> =>
    new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        pendingInstall.delete(id)
        resolve(false)
      }, PROMPT_TIMEOUT_MS)
      pendingInstall.set(id, { resolve, timer })
      // Smoke answers its own prompts, so no window shows one.
      if (extensionsSmoke.installPrompt) return extensionsSmoke.installPrompt({ ...prompt, id })
      sendToProfile(profileId, { type: 'extension-install-prompt', prompt: { ...prompt, id } }, true)
    })

  const askNative = (profileId: string, prompt: Omit<ExtensionNativePrompt, 'id'>): Promise<'once' | 'always' | 'deny'> =>
    new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        pendingNative.delete(id)
        resolve('deny')
      }, PROMPT_TIMEOUT_MS)
      pendingNative.set(id, { resolve, timer })
      sendToProfile(profileId, { type: 'extension-native-prompt', prompt: { ...prompt, id } }, true)
    })

  const host = new Host({
    adapter: deps.adapter ?? nativeAdapter,
    preloads: deps.preloads ?? null,
    extensionsDir: deps.extensionsDir ?? ((p) => extensionsDirFor(deps.dataDir, p)),
    nativeHostDirs: deps.nativeHostDirs ?? [join(deps.dataDir, 'NativeMessagingHosts')],
    windows,
    openTab: (p, url, opts) => deps.openTab?.(p, url, opts) ?? null,
    changed,
    askInstall,
    askNative,
    toast,
    registerShortcut: deps.registerShortcut ?? (() => ({ ok: true, dispose: () => {} })),
    clashesWith: deps.clashesWith ?? (() => null),
    chromeVersion: deps.chromeVersion ?? '0',
    contents: deps.contents,
    frameById: deps.frameById,
    browserSetting: deps.browserSetting,
  })

  const cleanups: Array<() => void> = []
  const chromeVersion = deps.chromeVersion ?? process.versions.chrome ?? '0'

  // Apple Passwords (macOS): Apple's extension from the Web Store, its helper and its pairing state.
  const apple = createApplePasswords({
    host,
    mac: deps.mac ?? process.platform === 'darwin',
    hostDirs: deps.nativeHostDirs ?? [join(deps.dataDir, 'NativeMessagingHosts')],
    fetchCrx: async (profileId) => {
      if (extensionsSmoke.fetchAppleCrx) return extensionsSmoke.fetchAppleCrx(profileId)
      if (deps.offline) throw new Error(mainT('extensions.apple.error.offline'))
      const session = host.sessionOf(profileId)
      if (!session) throw new Error(mainT('extensions.error.noProfile'))
      return downloadCrx(session, APPLE_PASSWORDS_EXTENSION_ID, chromeVersion)
    },
    openPopup: (profileId) => (extensionsSmoke.openApplePopup ? extensionsSmoke.openApplePopup(profileId) : host.openPopupFromExtension(profileId, APPLE_PASSWORDS_EXTENSION_ID)),
    yieldSetting: () => deps.yieldToPasswordExtension?.() ?? true,
    signedAsBrowser: () => signedAsBrowser(),
    emit: (profileId: string, status: ApplePasswordsStatus) => sendToProfile(profileId, { type: 'apple-passwords', status }, false),
  })
  cleanups.push(() => apple.dispose())
  const storeDeps = { host, toast, confirmRemove: deps.confirmRemove ?? (async () => false) }
  if (deps.preloads) {
    host.onWorker((profileId, extensionId, worker) => wireWorker(host, profileId, extensionId, worker))
    cleanups.push(wireFrames(host), wireWebStore(storeDeps, chromeVersion))
  }

  let updateTimer: NodeJS.Timeout | null = null
  if (!deps.offline && deps.preloads) {
    const run = (): void => {
      for (const profileId of host.profileIds()) void checkForUpdates(storeDeps, profileId, chromeVersion)
      updateTimer = setTimeout(run, UPDATE_EVERY_MS)
      updateTimer.unref?.()
    }
    updateTimer = setTimeout(run, UPDATE_FIRST_MS)
    updateTimer.unref?.()
  }

  const focusedWindow = (): ServiceWindow => {
    const profileId = profileNow()
    const win = windows().find((w) => w.profileId === profileId && w.focused) ?? windows().find((w) => w.profileId === profileId)
    if (!win) throw new Error(mainT('extensions.error.noWindow'))
    return win
  }

  const services: ExtensionsServices = {
    extensions: {
      list: () => host.list(profileNow()),
      setEnabled: (id, on) => {
        void host.setEnabled(profileNow(), id, on).catch((err: unknown) => log.warn('extensions', 'Turning an extension on or off failed', { id, error: err instanceof Error ? err.message : String(err) }))
      },
      pin: (id, on) => host.pin(profileNow(), id, on),
      remove: (id) => host.remove(profileNow(), id),
      revoke: (id, permission) => {
        void host.revoke(profileNow(), id, permission).catch((err: unknown) => log.warn('extensions', 'Revoking a permission failed', { id, error: err instanceof Error ? err.message : String(err) }))
      },
      runAction: (id, anchor) => host.runAction(profileNow(), id, focusedWindow(), anchor),
      openStore: () => void deps.openTab?.(profileNow(), WEB_STORE_URL, { active: true }),
      report: (id) => {
        const item = host.list(profileNow()).find((e) => e.id === id)
        if (!item?.storeUrl) throw new Error(mainT('extensions.error.noStore'))
        deps.openTab?.(profileNow(), storeSupportUrl(id), { active: true })
      },
      respondInstall: (promptId, allow) => {
        const pending = pendingInstall.get(promptId)
        if (!pending) return
        pendingInstall.delete(promptId)
        clearTimeout(pending.timer)
        pending.resolve(allow)
      },
      respondNative: (promptId, decision) => {
        const pending = pendingNative.get(promptId)
        if (!pending) return
        pendingNative.delete(promptId)
        clearTimeout(pending.timer)
        pending.resolve(decision)
      },
    },
    applePasswords: {
      status: () => apple.status(profileNow()),
      setOn: (on) => apple.setOn(profileNow(), on),
      pairAgain: () => apple.pairAgain(profileNow()),
    },
  }

  const extensions: Extensions = {
    services,
    host,
    apple,
    dispose: async () => {
      if (updateTimer) clearTimeout(updateTimer)
      for (const t of timers.values()) clearTimeout(t)
      for (const p of pendingInstall.values()) {
        clearTimeout(p.timer)
        p.resolve(false)
      }
      for (const p of pendingNative.values()) {
        clearTimeout(p.timer)
        p.resolve('deny')
      }
      for (const fn of cleanups) fn()
      host.dispose()
      if (current === extensions) current = null
    },
  }
  current = extensions
  return extensions
}
