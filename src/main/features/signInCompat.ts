/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session, WebContents } from 'electron'
import type { DialogSpec } from '@shared/dialogs'
import { dialogs } from '../dialogs'
import { mainT } from '../i18n/mainT'
import { permissionPolicy } from '../permissionPolicy'
import { accountLabel, configurePasskeys, installAccountChooser, storageAccessAnswer, type PasskeyAccount } from '../signInCompat'
import { registerWindowGeometry } from '../windowGeometry'
import type { AppContext, Feature } from './types'

// Sign-in compatibility (src/main/signInCompat.ts): iCloud Keychain and Touch ID
// passkeys when the signed app is entitled to them, and the account chooser every web session
// needs for discoverable passkeys. FedCM's switch is set before ready
// (signInEarly.ts); WebAuthn's fail-fast rules run in the page preload. The
// window's frame a page reads (outerWidth, screenX) comes in through
// windowGeometry.ts while Chromium has none for the page yet.

const MAX_ACCOUNTS = 6

/** The chooser: a button per account (the site's own names), Cancel last. */
export function passkeyChooserSpec(host: string, accounts: readonly PasskeyAccount[]): DialogSpec {
  return {
    title: mainT('menus.passkey.title', { host }),
    description: mainT('menus.passkey.body'),
    icon: 'lock',
    buttons: [
      ...accounts.slice(0, MAX_ACCOUNTS).map((a, i) => ({ id: `account:${i}`, label: accountLabel(a, mainT('menus.passkey.account', { n: i + 1 })), style: i === 0 ? ('primary' as const) : ('outline' as const), enter: i === 0 })),
      { id: 'cancel', label: mainT('menus.dialog.cancel'), style: 'secondary', escape: true, align: 'start' },
    ],
    dedupeKey: `passkey:${host}`,
  }
}

/** The credential id of the button pressed, or null (Cancel, dismissed). */
export function chosenAccount(button: string | null, accounts: readonly PasskeyAccount[]): string | null {
  const m = button ? /^account:(\d+)$/.exec(button) : null
  return m ? (accounts[Number(m[1])]?.credentialId ?? null) : null
}

export function createSignInCompatFeature(): Feature {
  let ctx: AppContext | null = null
  let stopGeometry: (() => void) | null = null
  /** The web sessions (default, private windows, profiles): sandbox partitions keep their own deny-all. */
  const web = new WeakSet<Session>()
  const choose = async (wc: WebContents | null, rpId: string, accounts: PasskeyAccount[]): Promise<string | null> => {
    const win = wc && !wc.isDestroyed() && ctx ? ctx.windows.fromWebContents(wc.id) : null
    if (!win || !wc) return null
    const tab = win.tabs.byWebContents(wc)
    const result = await dialogs.show(win, passkeyChooserSpec(rpId, accounts), tab ? { tabId: tab.id } : {})
    return chosenAccount(result.button, accounts)
  }
  return {
    name: 'signInCompat',
    app(app) {
      ctx = app
      stopGeometry = registerWindowGeometry()
      permissionPolicy.addOverride((r) => (web.has(r.session) ? storageAccessAnswer(r.permission, r.origin, app.settings.get().blockThirdPartyCookies) : null))
      if (app.smoke) return
      // Before any tab: tabs tell the page preload whether the system passkey sheet is on.
      configurePasskeys()
    },
    session(session) {
      web.add(session)
      installAccountChooser(session, choose)
    },
    dispose() {
      stopGeometry?.()
      stopGeometry = null
    },
  }
}
