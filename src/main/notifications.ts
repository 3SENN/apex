/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NotificationAction, NotificationCategory, NotificationHandle, NotificationTarget, NotifySpec } from '@shared/notifications'
import { log } from './log'

// System notifications (NS-01). notify is suppressed when the
// master switch or the category is off, when the chat is muted, or when the
// target chat is in view. The settings feature installs the presenter (the
// Electron one in notificationPresenter.ts); until then requests are logged
// and dropped.

export type NotificationPresenter = (spec: NotifySpec) => NotificationHandle

let presenter: NotificationPresenter | null = null

export const notifications = {
  notify(spec: NotifySpec): NotificationHandle {
    if (!presenter) {
      log.debug('notifications', 'Not available yet', { category: spec.category })
      return { clear: () => undefined }
    }
    return presenter(spec)
  },
  setPresenter(fn: NotificationPresenter | null): void {
    presenter = fn
  },
}

/** The suppression rules, pure so they can be tested. */
export function shouldNotify(
  spec: Pick<NotifySpec, 'category' | 'target'> & { sticky?: boolean },
  ctx: {
    enabled: boolean
    categories: Record<string, boolean>
    mutedChat(id: string): boolean
    chatInView(id: string): boolean
    /** An Apex window is in front. Without a chat, a notification then has nothing to add (the chrome shows it). */
    appFocused?: boolean
  },
): boolean {
  if (!ctx.enabled || ctx.categories[spec.category] === false) return false
  const chatId = spec.target.chatId
  if (chatId && (ctx.mutedChat(chatId) || ctx.chatInView(chatId))) return false
  if (!chatId && ctx.appFocused && !spec.sticky) return false
  return true
}

/** Whether the notification plays the system sound: only with Sounds on, and never for a silent request (one that plays Apex's own cue). */
export function notificationSilent(spec: Pick<NotifySpec, 'silent'>, soundsOn: boolean): boolean {
  return Boolean(spec.silent) || !soundsOn
}

/** The buttons a notification shows, in a stable order; empty where the platform has none. */
export function notificationButtons(actions: readonly NotificationAction[] | undefined, platform: NodeJS.Platform): NotificationAction[] {
  if (platform !== 'darwin' || !actions) return []
  const order: NotificationAction[] = ['take-notes', 'record', 'allow', 'deny', 'open-settings']
  return order.filter((a) => actions.includes(a))
}

/** A short key for grouping open notifications by what they point at (a chat's clear together once it is viewed). */
export function targetKey(target: NotificationTarget): string | null {
  if (target.chatId) return `chat:${target.chatId}`
  if (target.tabId) return `tab:${target.tabId}`
  return null
}

/** NS-03: with chat sounds on, Apex's own cue replaces the system sound for chat notifications. */
export function chatNotificationSilent(settings: { chatSounds?: boolean }, category: NotificationCategory): boolean {
  return settings.chatSounds === true && (category === 'needs-you' || category === 'chat-updates')
}
