/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AtelierApi } from '@shared/api'

// The chrome's UI kit and the companion's presence store read window.atelier
// when they load (the platform check, the chat and app event feeds). A float
// window only has window.atelierFloat, so before any of them load the voice
// floats put a quiet stand-in there: no events arrive and every service
// call is refused. Imported first by the HUD and the launcher.

const unsubscribe = (): (() => void) => () => undefined
const refused = (): Promise<never> => Promise.reject(new Error('Not available in a floating window.'))

if (typeof window !== 'undefined' && !(window as { atelier?: unknown }).atelier && (window as { atelierFloat?: unknown }).atelierFloat) {
  const platform = /Mac/i.test(navigator.platform) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'linux'
  const stand = {
    platform,
    invoke: refused,
    onAppEvent: unsubscribe,
    onCommand: unsubscribe,
    agent: { onEvent: unsubscribe, start: refused, send: refused, stop: refused, approve: refused, approveConnector: refused },
    settings: { get: refused, set: refused, setApiKey: refused },
  } as unknown as AtelierApi
  ;(window as { atelier?: AtelierApi }).atelier = stand
}

export {}
