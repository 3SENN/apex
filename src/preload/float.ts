/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Preload for Atelier's floating windows (launcher, voice HUD, meeting card,
// recording widget). Sandboxed: it exposes only `window.atelierFloat`, and main
// checks every call against the kind's own window and method list.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { FLOAT, type AtelierFloatApi, type FloatEvent, type FloatInitial, type FloatKind } from '@shared/float'

const boot = ipcRenderer.sendSync(FLOAT.ready) as { kind: FloatKind; initial: FloatInitial } | null

const listeners = new Set<(e: FloatEvent) => void>()
// Main may send right after this preload booted, before the page has mounted
// and subscribed. Payload, theme and companion events each carry the whole
// state, so the latest of each is kept and handed to every new listener: a
// launcher that opens while its page loads still shows what was heard.
const latest = new Map<FloatEvent['type'], FloatEvent>()
const deliver = (fn: (e: FloatEvent) => void, payload: FloatEvent): void => {
  try {
    fn(payload)
  } catch (err) {
    console.error(err)
  }
}
ipcRenderer.on(FLOAT.event, (_event: IpcRendererEvent, payload: FloatEvent) => {
  if (payload.type !== 'level') latest.set(payload.type, payload)
  for (const fn of [...listeners]) deliver(fn, payload)
})

if (boot) {
  const api: AtelierFloatApi = {
    kind: boot.kind,
    initial: boot.initial,
    platform: process.platform,
    invoke: (method, ...args) => ipcRenderer.invoke(FLOAT.invoke, method, args),
    onEvent: (fn) => {
      listeners.add(fn)
      for (const event of latest.values()) deliver(fn, event)
      return () => {
        listeners.delete(fn)
      }
    },
    requestSize: (size) => ipcRenderer.send(FLOAT.resize, { width: size.width, height: size.height }),
    close: () => ipcRenderer.send(FLOAT.close),
  }
  contextBridge.exposeInMainWorld('atelierFloat', api)
}
