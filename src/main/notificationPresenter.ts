/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Notification } from 'electron'
import type { NotificationAction, NotificationHandle, NotificationTarget, NotifySpec } from '@shared/notifications'
import type { SystemNotificationStatus } from '@shared/services/settings'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { chatNotificationSilent, notificationButtons, notificationSilent, shouldNotify, targetKey, type NotificationPresenter } from './notifications'
import type { Settings } from '@shared/ipc'

// The Electron presenter behind notifications.notify (NS-01). Approvals stay
// until handled (sticky, with Allow and Deny on macOS); a click focuses the
// right window, tab or chat; a chat's notifications close once it is viewed.

export interface PresenterDeps {
  settings(): Settings
  mutedChat(id: string): boolean
  /** The chat is on screen in a focused window. */
  chatInView(id: string): boolean
  appFocused(): boolean
  /** Brings the target forward: its window, then the tab or chat. */
  focusTarget(target: NotificationTarget): void
  /** 'open-settings' on a reconnect notification. */
  openSettings(target: NotificationTarget): void
  /** Called once when the first notification is shown (the one-time tip). */
  onFirstShown?(): void
  platform?: NodeJS.Platform
}

const ACTION_LABELS: Record<NotificationAction, Parameters<typeof mainT>[0]> = {
  allow: 'settings.notify.allow',
  deny: 'settings.notify.deny',
  'open-settings': 'settings.notify.openSettings',
  'take-notes': 'capture.card.takeNotes',
  record: 'capture.card.record',
}

export interface SystemPresenter {
  present: NotificationPresenter
  /** Closes every open notification for chats that are now in view. */
  clearViewed(): void
  /** How many are open (tests and diagnostics). */
  openCount(): number
}

export function createSystemPresenter(deps: PresenterDeps): SystemPresenter {
  const platform = deps.platform ?? process.platform
  const open = new Map<string, Set<Notification>>()
  let shownOnce = false

  const track = (key: string | null, note: Notification): void => {
    if (!key) return
    const set = open.get(key) ?? new Set<Notification>()
    set.add(note)
    open.set(key, set)
  }
  const untrack = (key: string | null, note: Notification): void => {
    if (!key) return
    const set = open.get(key)
    set?.delete(note)
    if (set && set.size === 0) open.delete(key)
  }

  const present: NotificationPresenter = (spec: NotifySpec): NotificationHandle => {
    const noop: NotificationHandle = { clear: () => undefined }
    const s = deps.settings()
    const allowed = shouldNotify(spec, {
      enabled: s.notifications.enabled,
      categories: s.notifications.categories,
      mutedChat: deps.mutedChat,
      chatInView: deps.chatInView,
      appFocused: deps.appFocused(),
    })
    if (!allowed || !Notification.isSupported()) return noop
    const buttons = notificationButtons(spec.actions, platform)
    let note: Notification
    try {
      note = new Notification({
        title: spec.title.slice(0, 200),
        body: spec.body.slice(0, 1000),
        // NS-03: Apex's own chat cue plays instead of the system sound while chat sounds are on.
        silent: notificationSilent(spec, s.notifications.sounds) || chatNotificationSilent(s, spec.category),
        timeoutType: spec.sticky ? 'never' : 'default',
        urgency: spec.category === 'needs-you' ? 'critical' : 'normal',
        actions: buttons.map((a) => ({ type: 'button' as const, text: mainT(ACTION_LABELS[a]) })),
      })
    } catch (err) {
      log.warn('notifications', 'Could not create a notification', { error: err instanceof Error ? err.message : String(err) })
      return noop
    }
    const key = targetKey(spec.target)
    let closed = false
    const clear = (): void => {
      if (closed) return
      closed = true
      untrack(key, note)
      note.close()
    }
    note.on('click', () => {
      deps.focusTarget(spec.target)
      clear()
    })
    note.on('action', (_event, index) => {
      const action = buttons[index]
      if (!action) return
      if (action === 'open-settings') deps.openSettings(spec.target)
      try {
        spec.onAction?.(action)
      } finally {
        clear()
      }
    })
    note.on('close', () => {
      closed = true
      untrack(key, note)
    })
    note.on('show', () => noteFailure(false))
    note.on('failed', (_event, error) => {
      noteFailure(true)
      log.warn('notifications', 'A notification failed to show', { error })
    })
    track(key, note)
    note.show()
    if (!shownOnce) {
      shownOnce = true
      deps.onFirstShown?.()
    }
    return { clear }
  }

  return {
    present,
    clearViewed() {
      for (const [key, notes] of open) {
        if (!key.startsWith('chat:') || !deps.chatInView(key.slice(5))) continue
        for (const note of [...notes]) note.close()
        open.delete(key)
      }
    },
    openCount() {
      let n = 0
      for (const set of open.values()) n += set.size
      return n
    },
  }
}

let lastFailure = false

/**
 * Whether the system lets Apex notify. Electron can't read the per-app
 * setting on macOS, so there it stays 'unknown' (the page then points to
 * System Settings); a notification the system refused (Windows reports it)
 * turns it to 'denied' until one shows again.
 */
export function systemNotificationStatus(): SystemNotificationStatus {
  if (!Notification.isSupported() || lastFailure) return 'denied'
  return process.platform === 'win32' ? 'allowed' : 'unknown'
}

function noteFailure(failed: boolean): void {
  lastFailure = failed
}
