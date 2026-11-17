/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'
import {
  APPLE_PASSWORDS_EXTENSION_ID as EXT_ID,
  APPLE_PASSWORDS_HOST as HOST,
  applePasswordsState,
  type ApplePasswordsInputs,
  type ApplePasswordsStatus,
} from '@shared/applePasswords'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { verifyCrx } from './crx'
import type { ExtensionsHost, HostObservation } from './host'
import { manifestCandidates, manifestHostPath, originAllowed } from './nativeMessaging'

// Apple Passwords (iCloud Keychain) as a built-in option on macOS. Atelier
// never ships Apple's extension: turning it on downloads it from the Chrome
// Web Store, verifies the package (its own key and the store's), asks once
// with the install prompt, installs it like any store install, allows its
// one native host (the person just said yes to it), pins its button and
// opens its popup for the 6-digit code. The card's status comes only from
// what can be observed: Apple's helper on disk, the extension running, its
// toolbar icon and the helper's own replies on the native port.

export interface ApplePasswordsDeps {
  host: ExtensionsHost
  mac: boolean
  /** The native-host folders the host reads, in order (Atelier's own, then Chrome's). */
  hostDirs: readonly string[]
  /** The package from the Web Store; tests and smoke hand over a local copy. */
  fetchCrx(profileId: string): Promise<Buffer>
  /** Opens the extension's popup in the profile's focused window, under its toolbar button. */
  openPopup(profileId: string): void
  /** The person lets password extensions take over (settings.autofill.yieldToPasswordExtension). */
  yieldSetting(): boolean
  /** A status changed for a profile. */
  emit(profileId: string, status: ApplePasswordsStatus): void
  /** Atelier is signed with Apple's browser passkey entitlement, so macOS lets it start the helper (codeSignature.ts). */
  signedAsBrowser?(): boolean
}

export interface HelperCheck {
  manifest: boolean
  binary: boolean
  allowsExtension: boolean
  path: string | null
}

/** Apple's helper as the host lookup would find it: the first manifest wins, as in findHost. */
export function checkHelper(dirs: readonly string[], extensionId = EXT_ID, hostName = HOST): HelperCheck {
  for (const file of manifestCandidates(hostName, dirs)) {
    if (!existsSync(file)) continue
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown; path?: unknown; type?: unknown; allowed_origins?: unknown }
      const path = manifestHostPath(file, m.path)
      const allows = m.name === hostName && m.type === 'stdio' && Array.isArray(m.allowed_origins) && m.allowed_origins.some((o) => originAllowed(o, extensionId))
      return { manifest: true, binary: !!path && existsSync(path), allowsExtension: allows, path }
    } catch {
      return { manifest: true, binary: false, allowsExtension: false, path: null }
    }
  }
  return { manifest: false, binary: false, allowsExtension: false, path: null }
}

/** The pieces of a verified package the install prompt shows: its manifest, localized name and icon. */
export function packageFacts(archive: Buffer): { manifestJson: string; name: string; icon: string | null } {
  const files = unzipSync(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength), {
    filter: (f) => f.name === 'manifest.json' || /^_locales\/[^/]+\/messages\.json$/.test(f.name) || /\.png$/i.test(f.name),
  })
  const text = (name: string): string | null => {
    const data = files[name]
    return data ? Buffer.from(data).toString('utf8').replace(/^﻿/, '') : null
  }
  const manifestJson = text('manifest.json')
  if (!manifestJson) throw new Error('The extension package has no manifest.')
  const m = JSON.parse(manifestJson) as { name?: string; default_locale?: string; icons?: Record<string, string> }
  let name = typeof m.name === 'string' ? m.name : ''
  const msg = /^__MSG_(\w+)__$/.exec(name)?.[1]
  if (msg) {
    const messages = text(`_locales/${m.default_locale ?? 'en'}/messages.json`)
    const found = messages ? (JSON.parse(messages) as Record<string, { message?: string }>)[msg]?.message : undefined
    name = found ?? ''
  }
  const iconPath = m.icons ? (m.icons['128'] ?? m.icons['48'] ?? Object.values(m.icons)[0]) : undefined
  const iconData = iconPath ? files[iconPath.replace(/^\/+/, '')] : undefined
  const icon = iconData ? `data:image/png;base64,${Buffer.from(iconData).toString('base64')}` : null
  return { manifestJson, name, icon }
}

/** What the extension's helper said last on the port (the extension's own command numbers). */
interface Observed {
  lastCmd: number | null
  codeRequested: boolean
}

const CMD_CHALLENGE = 2

export function createApplePasswords(deps: ApplePasswordsDeps) {
  const { host } = deps
  const observed = new Map<string, Observed>()
  const installing = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const seen = (profileId: string): Observed => {
    let o = observed.get(profileId)
    if (!o) observed.set(profileId, (o = { lastCmd: null, codeRequested: false }))
    return o
  }

  const inputs = (profileId: string): ApplePasswordsInputs => {
    const item = host.list(profileId).find((e) => e.id === EXT_ID)
    const helper = checkHelper(deps.hostDirs)
    const port = host.nativeState(profileId, EXT_ID, HOST)
    const o = seen(profileId)
    return {
      mac: deps.mac,
      installing: installing.has(profileId),
      helper,
      extension: { installed: !!item, enabled: !!item?.enabled, running: !!item && host.isLoaded(profileId, EXT_ID) },
      port,
      iconPath: host.actionIconPath(profileId, EXT_ID),
      lastHelperCmd: o.lastCmd,
      codeRequested: o.codeRequested,
      signedAsBrowser: deps.signedAsBrowser?.() ?? false,
    }
  }

  const status = (profileId: string): ApplePasswordsStatus => {
    const i = inputs(profileId)
    const holder = host.passwordSavingHeldOff(profileId)
    return {
      state: applePasswordsState(i),
      installed: i.extension.installed,
      enabled: i.extension.enabled,
      atelierStepsAside: !!holder && deps.yieldSetting(),
      otherController: holder && holder.extensionId !== EXT_ID ? holder.name : null,
      error: i.port && !i.port.open ? i.port.closedWithError : null,
      signedAsBrowser: i.signedAsBrowser ?? false,
    }
  }

  /** Statuses go out once per beat: a pairing burst sends a handful of port messages. */
  const notify = (profileId: string): void => {
    if (timers.has(profileId)) return
    timers.set(
      profileId,
      setTimeout(() => {
        timers.delete(profileId)
        try {
          deps.emit(profileId, status(profileId))
        } catch (err) {
          log.debug('extensions', 'Apple Passwords status failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }, 50),
    )
  }

  const onObservation = (ob: HostObservation): void => {
    if (ob.type === 'setting') return notify(ob.profileId)
    if (ob.extensionId !== EXT_ID || ob.host !== HOST) return
    const o = seen(ob.profileId)
    if (ob.event === 'open') {
      o.lastCmd = null
      o.codeRequested = false
    } else if (ob.event === 'message' && ob.message && typeof ob.message === 'object') {
      const m = ob.message as { cmd?: unknown; payload?: unknown }
      if (typeof m.cmd === 'number') o.lastCmd = m.cmd
      const qid = m.payload && typeof m.payload === 'object' ? (m.payload as { QID?: unknown }).QID : undefined
      // The helper's answer to the pairing challenge ("m0"): macOS now shows the code. Its "m2" answer ends pairing.
      if (m.cmd === CMD_CHALLENGE && qid === 'm0') o.codeRequested = true
      if (m.cmd === CMD_CHALLENGE && qid === 'm2') o.codeRequested = false
    } else if (ob.event === 'post' && ob.message && typeof ob.message === 'object') {
      // The popup closed mid-pairing (the extension's cmd 19), or a new challenge goes out: no code is waiting.
      const cmd = (ob.message as { cmd?: unknown }).cmd
      if (cmd === 19) o.codeRequested = false
    }
    notify(ob.profileId)
  }
  const unobserve = host.observe(onObservation)

  const openPopupSoon = async (profileId: string): Promise<void> => {
    // Give the worker a moment to start and reach the helper, so the popup opens on its pairing step.
    const until = Date.now() + 3000
    const answered = (): boolean => {
      const port = host.nativeState(profileId, EXT_ID, HOST)
      return !!port?.open && port.replied
    }
    while (Date.now() < until && !answered()) await new Promise((r) => setTimeout(r, 100))
    try {
      deps.openPopup(profileId)
    } catch (err) {
      log.debug('extensions', 'Could not open the Apple Passwords popup', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const turnOn = async (profileId: string): Promise<ApplePasswordsStatus> => {
    if (!deps.mac) throw new Error(mainT('extensions.apple.error.mac'))
    const helper = checkHelper(deps.hostDirs)
    if (!helper.manifest || !helper.binary || !helper.allowsExtension) throw new Error(mainT('extensions.apple.error.helper'))
    const installed = host.list(profileId).some((e) => e.id === EXT_ID)
    if (!installed) {
      installing.add(profileId)
      notify(profileId)
      try {
        // Download and verify first, so the prompt shows exactly the package that gets installed.
        const crx = await deps.fetchCrx(profileId)
        const checked = verifyCrx(crx, { expectedId: EXT_ID, requirePublisher: true })
        const facts = packageFacts(checked.archive)
        const answer = await host.beginStoreInstall(profileId, EXT_ID, facts.manifestJson, facts.name, facts.icon)
        if (answer.unsupported) throw new Error(answer.unsupported)
        if (!answer.ok) return status(profileId)
        // The person said yes to an extension whose whole job is this helper: no second question.
        host.allowNativeHost(profileId, EXT_ID, HOST)
        await host.installPackage(profileId, EXT_ID, crx, { approvedOnly: true })
      } finally {
        installing.delete(profileId)
        notify(profileId)
      }
    } else {
      host.allowNativeHost(profileId, EXT_ID, HOST)
      await host.setEnabled(profileId, EXT_ID, true)
    }
    host.pin(profileId, EXT_ID, true)
    void openPopupSoon(profileId)
    return status(profileId)
  }

  return {
    status,
    notify,
    async setOn(profileId: string, on: boolean): Promise<ApplePasswordsStatus> {
      if (on) return turnOn(profileId)
      if (host.list(profileId).some((e) => e.id === EXT_ID)) await host.setEnabled(profileId, EXT_ID, false)
      seen(profileId).codeRequested = false
      notify(profileId)
      return status(profileId)
    },
    async pairAgain(profileId: string): Promise<ApplePasswordsStatus> {
      const item = host.list(profileId).find((e) => e.id === EXT_ID)
      if (!item?.enabled) throw new Error(mainT('extensions.apple.error.off'))
      await host.reload(profileId, EXT_ID)
      void openPopupSoon(profileId)
      return status(profileId)
    },
    dispose(): void {
      unobserve()
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}

export type ApplePasswords = ReturnType<typeof createApplePasswords>
