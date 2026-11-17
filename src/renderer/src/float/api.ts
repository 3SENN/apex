/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react'
import { accentVariables } from '@shared/accent'
import type { ApexFloatApi, FloatEvent } from '@shared/float'
import type { ThemeState } from '@shared/theme'

// The float page's side of window.apexFloat: the theme on <html>, the
// live payload and level events. A float never sees window.apex.

declare global {
  interface Window {
    apexFloat?: ApexFloatApi
  }
}

/** The bridge, or null when the page was opened outside a float window. */
export const floatApi: ApexFloatApi | null = typeof window !== 'undefined' ? (window.apexFloat ?? null) : null

/** Sets data-theme and the companion accent variables, as the chrome's theme.ts does. */
export function applyFloatTheme(theme: ThemeState): void {
  const root = document.documentElement
  root.dataset.theme = theme.mode
  root.dataset.themePref = theme.preference
  for (const [name, value] of Object.entries(accentVariables(theme.accent))) root.style.setProperty(name, value)
}

/** Subscribes to float events for the component's lifetime. */
export function useFloatEvent(fn: (e: FloatEvent) => void): void {
  useEffect(() => floatApi?.onEvent(fn), [fn])
}

/** The kind's live payload: the initial one, then every 'payload' event. */
export function useFloatPayload<T>(): T | null {
  const [payload, setPayload] = useState<T | null>((floatApi?.initial.payload as T | null) ?? null)
  useEffect(
    () =>
      floatApi?.onEvent((e) => {
        if (e.type === 'payload') setPayload(e.payload as T)
      }),
    [],
  )
  return payload
}

/** Calls a method on the kind's allowlist (FLOAT_METHODS); rejects when outside a float. */
export function floatInvoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  if (!floatApi) return Promise.reject(new Error('Not in a float window.'))
  return floatApi.invoke(method, ...args) as Promise<T>
}
