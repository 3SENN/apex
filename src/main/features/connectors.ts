/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import { loginShell } from '../system/shell'
import { setupConnectors } from '../connectors/service'
import { mainT } from '../i18n/mainT'
import { notifications } from '../notifications'
import type { Feature } from './types'

// The connectors feature module: the connector directory, custom and local servers,
// OAuth and record search. Its services add methods to the base `connectors`
// namespace; it fills ctx.content.connectors with the ConnectorRuntime.
export function createConnectorsFeature(): Feature {
  let dispose: (() => void | Promise<void>) | null = null
  return {
    name: 'connectors',
    app(ctx) {
      let loginPath: Promise<string | null> | null = null
      const connectors = setupConnectors({
        dataDir: ctx.dataDir,
        // Favicons go through the default profile's session, and stay off in smoke (offline rule).
        iconFetch: ctx.smoke
          ? null
          : async (url, signal) => {
              const res = await ctx.content.profiles.sessionFor(DEFAULT_PROFILE_ID).fetch(url, { signal, redirect: 'follow' })
              return { ok: res.ok, contentType: res.headers.get('content-type'), body: await res.arrayBuffer() }
            },
        // Sign-in opens in a new tab of the focused window; the tab closes once the redirect arrives.
        openSignIn: (url) => {
          const win = ctx.windows.focused()
          if (!win) throw new Error(mainT('connectors.error.noWindow'))
          const tab = win.tabs.create(url)
          return () => {
            if (win.tabs.find(tab.id)) win.tabs.close(tab.id)
          }
        },
        loginPath: () => (loginPath ??= loginShell(process.env.SHELL, 'printf %s "$PATH"')),
        notify: (title, body, url) => void notifications.notify({ category: 'needs-you', title, body, target: { url } }),
      })
      ctx.content.connectors = connectors.runtime
      dispose = connectors.dispose
      return connectors.services
    },
    dispose: () => dispose?.(),
  }
}
