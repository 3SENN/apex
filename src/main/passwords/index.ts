/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, clipboard, dialog, powerMonitor, safeStorage, shell, systemPreferences } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import type { PasswordsServices } from '@shared/passwords'
import type { SpeechBroker } from '@shared/speech'
import { registerMenuContribution } from '@shared/menuModel'
import { dialogs } from '../dialogs'
import type { AppContext } from '../features/types'
import type { Authenticator, VaultApi, Wallet } from '../features/personalRuntime'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { registerResetStep } from '../reset'
import { createAuthenticator, UnlockWindow } from './auth'
import { ImportFiles } from './importFiles'
import { createPasswordsServices, type PasswordsPlatform } from './service'
import { PasswordVault, type VaultCipher } from './vault'
import { WalletStore } from './wallet'

// The passwords domain's entry point: the vault, the wallet,
// the authenticator and the Passwords page's unlock window, the passwords
// and wallet services, and the core registry hooks (the main menu's Passwords
// entry, the Reset step). Nothing from the vault or wallet is ever logged
// or handed to the agent.

export interface PasswordsSetup {
  vault: VaultApi
  wallet: Wallet
  auth: Authenticator
  services: PasswordsServices
  dispose(): void
}

/** The OS keychain (Keychain on macOS) through Electron's safeStorage. */
const keychainCipher: VaultCipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
}

/**
 * APEX_SMOKE only, on a throwaway data folder: a reversible scramble so the
 * smoke run never asks the real keychain for access. Never used otherwise.
 */
const smokeCipher: VaultCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
}

/** How long a copied password stays on the clipboard. */
const CLIPBOARD_CLEAR_MS = 60_000
const PASSWORDS_APP = '/System/Applications/Passwords.app'
const PASSWORDS_SETTINGS = 'x-apple.systempreferences:com.apple.Passwords-Settings.extension'

// Smoke hooks: the next file a picker returns, and the last copied secret (the real clipboard is left alone).
const smokePicks: string[] = []
let smokeCopied: string | null = null
export const smokePasswords = {
  queuePick(path: string): void {
    smokePicks.push(path)
  },
  lastCopied(): string | null {
    return smokeCopied
  },
}

export function setupPasswords(ctx: AppContext, deps: { broker: SpeechBroker }): PasswordsSetup {
  const cipher = ctx.smoke ? smokeCipher : keychainCipher
  const vault = new PasswordVault(ctx.dataDir, cipher)
  const wallet = new WalletStore(ctx.dataDir, cipher)
  const files = new ImportFiles(ctx.dataDir, cipher)
  // A crash mid-import can leave a copy behind; it goes before anything else runs.
  files.cleanup()

  const sendStatus = (): void => {
    ctx.broadcast({ type: 'passwords', count: vault.count(), locked: !unlock.isUnlocked() })
  }
  const unlock = new UnlockWindow(() => sendStatus())

  const auth = createAuthenticator({
    platform: process.platform,
    smoke: ctx.smoke,
    touchId: {
      can: () => process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
      prompt: (reason) => systemPreferences.promptTouchID(reason),
    },
    helper: { authenticate: (reason) => deps.broker.authenticate(reason) },
    confirm: (reason) => confirmIdentity(ctx, reason),
  })

  const platform: PasswordsPlatform = {
    async pickCsv(purpose) {
      if (ctx.smoke) return smokePicks.shift() ?? null
      const win = ctx.windows.focused()?.window
      const options: Electron.OpenDialogOptions = {
        title: mainT(purpose === 'system' ? 'passwords.import.pickSystemTitle' : 'passwords.import.pickTitle'),
        properties: ['openFile'],
        filters: [{ name: mainT('passwords.import.csvFilter'), extensions: ['csv'] }],
        defaultPath: purpose === 'system' ? app.getPath('documents') : app.getPath('downloads'),
      }
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? null : (picked.filePaths[0] ?? null)
    },
    openSystemPasswords() {
      if (process.platform !== 'darwin') throw new Error(mainT('passwords.system.macOnly'))
      if (ctx.smoke) return
      if (existsSync(PASSWORDS_APP)) void shell.openPath(PASSWORDS_APP)
      else void shell.openExternal(PASSWORDS_SETTINGS)
    },
    async trash(path) {
      if (ctx.smoke) rmSync(path, { force: true })
      else await shell.trashItem(path)
    },
    copySecret(text) {
      if (ctx.smoke) {
        smokeCopied = text
        return
      }
      clipboard.writeText(text)
      const timer = setTimeout(() => {
        // Only clear it if you haven't copied something else since.
        void Promise.resolve(clipboard.readText()).then((current) => {
          if (current === text) clipboard.clear()
        })
      }, CLIPBOARD_CLEAR_MS)
      timer.unref?.()
    },
  }

  const services = createPasswordsServices({
    vault,
    wallet,
    auth,
    unlock,
    files,
    platform,
    onImported: () => {
      if (!ctx.settings.get().autofill.passwordsImported) ctx.settings.update({ autofill: { passwordsImported: true } })
    },
  })

  const offVault = vault.onChange(sendStatus)
  const offWallet = wallet.onChange(() => ctx.broadcast({ type: 'wallet' }))

  // The page relocks when the Mac locks or sleeps.
  const relock = (): void => unlock.lock()
  powerMonitor.on('lock-screen', relock)
  powerMonitor.on('suspend', relock)

  // SH-54: the main menu's Passwords entry, through the core registry.
  const unregisterMenu = registerMenuContribution({
    id: 'b-passwords',
    target: 'main-menu:tools',
    build: () => [{ id: 'open-passwords', label: mainT('passwords.menu.entry'), commandId: 'open-passwords', icon: 'key-round' }],
  })
  const unregisterCommand = ctx.commands.register('open-passwords', (win) => {
    win?.tabs.openInternal('apex://passwords', { newTab: true })
  })
  // ST-55: Reset wipes the vault and wallet, only with the secrets box ticked.
  const unregisterReset = registerResetStep({
    id: 'passwords-vault',
    order: 90,
    label: mainT('passwords.reset.label'),
    secrets: true,
    run: async ({ dryRun }) => {
      if (!dryRun) {
        unlock.lock()
        files.dispose()
        vault.wipe()
        wallet.wipe()
        log.info('passwords', 'Reset wiped the password vault and wallet')
      }
      return { removed: [mainT('passwords.reset.vault'), mainT('passwords.reset.wallet')] }
    },
  })

  return {
    vault,
    wallet,
    auth,
    services,
    dispose: () => {
      unlock.dispose()
      files.dispose()
      offVault()
      offWallet()
      powerMonitor.off('lock-screen', relock)
      powerMonitor.off('suspend', relock)
      unregisterMenu()
      unregisterCommand()
      unregisterReset()
    },
  }
}

/** Off macOS: an Apex confirm dialog, or the native one until the overlay dialogs land. */
async function confirmIdentity(ctx: AppContext, reason: string): Promise<boolean> {
  const win = ctx.windows.focused()
  if (!win) throw new Error('No window to ask in')
  try {
    return await dialogs.confirm(win, {
      title: mainT('passwords.auth.confirmTitle'),
      description: reason,
      icon: 'lock',
      buttons: [
        { id: 'cancel', label: mainT('passwords.auth.confirmCancel'), style: 'ghost', escape: true },
        { id: 'ok', label: mainT('passwords.auth.confirmOk'), style: 'primary', enter: true },
      ],
      dedupeKey: 'passwords-auth',
    })
  } catch {
    const { response } = await dialog.showMessageBox(win.window, {
      type: 'question',
      message: mainT('passwords.auth.confirmTitle'),
      detail: reason,
      buttons: [mainT('passwords.auth.confirmOk'), mainT('passwords.auth.confirmCancel')],
      defaultId: 0,
      cancelId: 1,
    })
    return response === 0
  }
}
