/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, type AuthInfo, type AuthenticationResponseDetails, type WebContents } from 'electron'
import type { DialogSpec } from '@shared/dialogs'
import { t } from '@shared/i18n/core'
import { dialogs } from './dialogs'
import type { AppContext, WindowContext } from './features/types'

// HTTP and proxy sign-in (OV-08): the app `login` event, answered
// asynchronously from Atelier's dialog. The proxy settings rely on this too.
// The realm is the site's own text, so it is shown as a quote, never as
// Atelier's words.

export interface SignInRequest {
  host: string
  realm: string
  isProxy: boolean
  /** Plain http: the password would travel unencrypted. */
  insecure: boolean
}

export function signInSpec(req: SignInRequest): DialogSpec {
  const callouts = [req.realm ? t('menus.signIn.realm', { realm: req.realm.slice(0, 200) }) : null, req.insecure && !req.isProxy ? t('menus.signIn.insecure') : null].filter(Boolean)
  return {
    title: req.isProxy ? t('menus.signIn.proxyTitle') : t('menus.signIn.title', { host: req.host }),
    description: req.isProxy ? t('menus.signIn.proxyBody', { host: req.host }) : t('menus.signIn.body'),
    icon: 'lock',
    ...(callouts.length ? { callout: callouts.join('\n') } : {}),
    inputs: [
      { id: 'username', label: t('menus.signIn.username'), type: 'text' },
      { id: 'password', label: t('menus.signIn.password'), type: 'password' },
    ],
    buttons: [
      { id: 'cancel', label: t('menus.dialog.cancel'), style: 'secondary', escape: true, align: 'end' },
      { id: 'sign-in', label: t('menus.signIn.submit'), style: 'primary', enter: true, align: 'end' },
    ],
    // Several requests for the same realm share one question and one answer.
    dedupeKey: `sign-in:${req.isProxy ? 'proxy' : 'site'}:${req.host}:${req.realm}`,
  }
}

/** Asks for a username and password; null when you cancel. */
export async function askSignIn(win: WindowContext, req: SignInRequest, tabId: string | null): Promise<{ username: string; password: string } | null> {
  // A proxy sign-in serves the whole window; a site's belongs to its tab.
  const result = await dialogs.show(win, signInSpec(req), tabId && !req.isProxy ? { tabId } : {})
  if (result.button !== 'sign-in') return null
  return { username: result.inputs.username ?? '', password: result.inputs.password ?? '' }
}

function requestOf(details: AuthenticationResponseDetails, info: AuthInfo): SignInRequest {
  let insecure = false
  try {
    insecure = new URL(details.url).protocol === 'http:'
  } catch {
    // An unparsable address keeps the default.
  }
  return { host: info.port && ![80, 443].includes(info.port) ? `${info.host}:${info.port}` : info.host, realm: info.realm ?? '', isProxy: info.isProxy, insecure }
}

/** Installs the app-wide `login` handler (once, at start). */
export function installSignIn(ctx: AppContext): void {
  app.on('login', (event, webContents: WebContents | null, details, authInfo, callback) => {
    const win = (webContents && !webContents.isDestroyed() ? ctx.windows.fromWebContents(webContents.id) : null) ?? ctx.windows.focused()
    if (!win) return
    event.preventDefault()
    const tabId = webContents && !webContents.isDestroyed() ? (win.tabs.byWebContents(webContents)?.id ?? null) : null
    askSignIn(win, requestOf(details, authInfo), tabId).then(
      (creds) => (creds ? callback(creds.username, creds.password) : callback()),
      () => callback(),
    )
  })
}
