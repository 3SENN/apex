/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DialogSpec, ToastOutcome, ToastWire } from '@shared/dialogs'
import { confirmSpec } from '@shared/dialogLogic'
import { t } from '@shared/i18n/core'

// Small observable stores behind the kit's hosts (toasts, confirmations) and
// the overlay reference count, plus how a kit toast or confirm becomes what
// main's overlay draws (OV-05, OV-08). No DOM, so they are unit tested directly.

type Listener = () => void

export interface Queue<T extends { id: string }> {
  items(): readonly T[]
  /** Adds an item, replacing one with the same id. Returns items pushed out. */
  push(item: T): { replaced: T | null; dropped: T[] }
  remove(id: string): T | null
  subscribe(listener: Listener): () => void
}

/** A list capped at `max` items; the oldest go first when it is full. */
export function createQueue<T extends { id: string }>(max = Infinity): Queue<T> {
  let list: readonly T[] = []
  const listeners = new Set<Listener>()
  const emit = (): void => listeners.forEach((l) => l())
  return {
    items: () => list,
    push(item) {
      const replaced = list.find((t) => t.id === item.id) ?? null
      const next = replaced ? list.map((t) => (t.id === item.id ? item : t)) : [...list, item]
      const dropped = next.length > max ? next.slice(0, next.length - max) : []
      list = dropped.length ? next.slice(dropped.length) : next
      emit()
      return { replaced, dropped }
    },
    remove(id) {
      const found = list.find((t) => t.id === id) ?? null
      if (!found) return null
      list = list.filter((t) => t.id !== id)
      emit()
      return found
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export interface RefCount {
  /** Takes a hold; the returned release is safe to call more than once. */
  acquire(): () => void
  readonly count: number
}

/** Calls onChange(true) on the first hold and onChange(false) when the last one goes. */
export function createRefCount(onChange: (active: boolean) => void): RefCount {
  let count = 0
  return {
    get count() {
      return count
    },
    acquire() {
      if (count++ === 0) onChange(true)
      let released = false
      return () => {
        if (released) return
        released = true
        if (--count === 0) onChange(false)
      }
    },
  }
}

let nextId = 0
/** Ids for queue items that did not bring their own. */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++nextId}`
}


const TOAST_OUTCOMES: readonly ToastOutcome[] = ['undo', 'action', 'timeout', 'closed', 'replaced', 'tab-switch']

export function isToastOutcome(value: unknown): value is ToastOutcome {
  return typeof value === 'string' && (TOAST_OUTCOMES as readonly string[]).includes(value)
}

/** The kit's dismiss reasons, which a toast's onDismiss receives. */
export type KitToastReason = 'timeout' | 'closed' | 'action' | 'undo' | 'replaced' | 'overflow'

/** How the overlay's toast ended, as the kit's dismiss reason (the callbacks run in the chrome, not in main). */
export function reasonFor(outcome: ToastOutcome): KitToastReason {
  return outcome === 'tab-switch' ? 'closed' : outcome
}

/** What a kit toast needs to cross to main. */
export interface KitToast {
  id: string
  message: unknown
  tone?: 'neutral' | 'success' | 'error' | 'info'
  action?: { label: string }
  undo?: unknown
  duration?: number
}

/** A toast as it crosses to main, or null when it has to stay in the chrome (a rich or overlong message). */
export function toastWire(record: KitToast): (ToastWire & { id: string }) | null {
  const { message } = record
  if (typeof message !== 'string' && typeof message !== 'number') return null
  const text = String(message).trim()
  if (!text || text.length > 500) return null
  const tone = record.tone ?? 'neutral'
  return {
    id: record.id.slice(0, 128),
    kind: tone === 'error' ? 'error' : tone === 'success' ? 'success' : 'info',
    text,
    ...(record.action ? { action: { id: 'action', label: record.action.label.slice(0, 60) } } : {}),
    ...(record.undo ? { undo: true } : {}),
    ...(record.duration !== undefined ? { durationMs: Math.max(0, Math.min(120_000, Math.round(record.duration))) } : {}),
  }
}

/** What a kit confirm needs to become a dialog spec. */
export interface KitConfirm {
  title: string
  message?: unknown
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

/** The spec a confirm becomes in the overlay, or null when its message isn't plain text. */
export function confirmOptionsSpec(options: KitConfirm): DialogSpec | null {
  const raw = options.message
  if (raw !== undefined && raw !== null && typeof raw !== 'string' && typeof raw !== 'number') return null
  const message = raw === undefined || raw === null ? '' : String(raw).trim()
  return confirmSpec({
    title: options.title,
    ...(message ? { message } : {}),
    confirmLabel: options.confirmLabel ?? (options.destructive ? t('menus.confirm.delete') : t('menus.confirm.continue')),
    cancelLabel: options.cancelLabel ?? t('menus.dialog.cancel'),
    destructive: options.destructive ?? false,
    // A double press asks once; both callers get the one answer.
    dedupeKey: `chrome:${options.title}:${message}`.slice(0, 256),
  })
}
