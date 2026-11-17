/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { EMPTY_MEDIA_STATE, type MediaCommand, type MediaHubState } from '@shared/media'
import { atelier, call, errorText } from '../../api'
import { t } from '../../i18n/useT'
import { toast } from '../../ui'

// The chrome's copy of the window's media sources (MD-01): loaded once, then
// kept by main's `media` events, and shared by the toolbar button, the sidebar
// card and the popover they open. Also the `nowPlayingButton` setting, so the
// toolbar needn't pass settings down.

interface Snapshot {
  state: MediaHubState
  button: boolean
}

let snapshot: Snapshot = { state: EMPTY_MEDIA_STATE, button: true }
const listeners = new Set<() => void>()
let started = false

function set(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}

function start(): void {
  if (started) return
  started = true
  try {
    const initial = atelier.initial?.settings
    if (initial && typeof initial.nowPlayingButton === 'boolean') snapshot = { ...snapshot, button: initial.nowPlayingButton }
  } catch {
    // No initial settings (a float page); the button shows by default.
  }
  atelier.onAppEvent((event) => {
    if (event.type === 'media') set({ state: event.state })
    else if (event.type === 'settings' && typeof event.view.nowPlayingButton === 'boolean' && event.view.nowPlayingButton !== snapshot.button) set({ button: event.view.nowPlayingButton })
  })
  void Promise.resolve(call('media', 'state'))
    .then((state) => set({ state }))
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMedia(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

function failed(err: unknown): void {
  toast.show({ message: `${t('media.error')} ${errorText(err)}`, tone: 'error' })
}

/** The source's buttons, from the chrome or the popover. */
export function runMedia(tabId: string, command: MediaCommand): void {
  void Promise.resolve(call('media', 'control', tabId, command)).catch(failed)
}

export function setMediaRate(tabId: string, rate: number): void {
  void Promise.resolve(call('media', 'setRate', tabId, rate)).catch(failed)
}

export function toggleMediaPip(tabId: string): void {
  void Promise.resolve(call('media', 'pictureInPicture', tabId)).catch(failed)
}

export function focusMedia(tabId: string): void {
  void Promise.resolve(call('media', 'focus', tabId)).catch(failed)
}
