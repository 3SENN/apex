/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Notification categories and the notify request. Each category
// has its own switch under Settings › Notifications; the meetings and
// passwords features produce `meetings` and `passwords`.
import type { MessageKey } from './i18n/en'

export const NOTIFICATION_CATEGORIES = ['needs-you', 'chat-updates', 'routine-results', 'meetings', 'downloads', 'passwords', /* packs (docs/packs.md): apex.notify */ 'packs'] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, MessageKey> = {
  'needs-you': 'settings.notifications.category.needsYou',
  'chat-updates': 'settings.notifications.category.chatUpdates',
  'routine-results': 'settings.notifications.category.routineResults',
  meetings: 'settings.notifications.category.meetings',
  downloads: 'settings.notifications.category.downloads',
  passwords: 'settings.notifications.category.passwords',
  packs: 'settings.notifications.category.packs',
}

/** 'take-notes', or 'record' when it would be audio only: a desktop call's offer (meetings). */
export type NotificationAction = 'allow' | 'deny' | 'open-settings' | 'take-notes' | 'record'

export interface NotificationTarget {
  windowId?: number
  tabId?: string
  chatId?: string
  url?: string
}

export interface NotifySpec {
  category: NotificationCategory
  title: string
  body: string
  target: NotificationTarget
  actions?: NotificationAction[]
  sticky?: boolean
  /** No system sound: Apex's own chat sounds (NS-03) play instead, or a quiet routine result. */
  silent?: boolean
  onAction?(action: string): void
}

export interface NotificationHandle {
  clear(): void
}

/** The attention state the tray reads. */
export interface AttentionState {
  unread: number
  needsYou: number
}
