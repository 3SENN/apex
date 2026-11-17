/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import type { ToastOutcome, ToastWire } from '@shared/dialogs'
import { toastTiming } from '@shared/toastTiming'
import { t } from '../i18n/useT'
import { Button, IconButton } from './Button'
import { cx } from './logic/format'
import { createQueue, isToastOutcome, reasonFor, toastWire, uniqueId } from './logic/queues'
import { usePresenceList, type PresencePhase } from './motion'
import { useOverlay } from './overlay'

export type ToastTone = 'neutral' | 'success' | 'error' | 'info'
export type ToastDismissReason = 'timeout' | 'closed' | 'action' | 'undo' | 'replaced' | 'overflow'

export interface ToastOptions {
  /** Reusing an id replaces that toast in place (e.g. "Duplicating…" then "Duplicated"). */
  id?: string
  message: ReactNode
  tone?: ToastTone
  /** One extra button. */
  action?: { label: string; onAction(): void }
  /** Adds an Undo button; pressing it runs this and closes the toast. */
  undo?: () => void
  /** Milliseconds before it closes; 0 keeps it open. Defaults to about 2 s, longer with Undo, an action or an error (shared/toastTiming). */
  duration?: number
  /** Called once when the toast goes, with the reason. Deferred deletes commit here unless the reason is 'undo'. */
  onDismiss?(reason: ToastDismissReason): void
}

export interface ToastApi {
  /** Shows a toast and returns its id. */
  show(options: ToastOptions): string
  dismiss(id: string): void
}

interface ToastRecord extends ToastOptions {
  id: string
}

const MAX_TOASTS = 3
const queue = createQueue<ToastRecord>(MAX_TOASTS)

function close(id: string, reason: ToastDismissReason): void {
  queue.remove(id)?.onDismiss?.(reason)
}

function showLocal(record: ToastRecord): string {
  const { replaced, dropped } = queue.push(record)
  if (replaced && replaced !== record) replaced.onDismiss?.('replaced')
  for (const old of dropped) old.onDismiss?.('overflow')
  return record.id
}

// OV-05: toasts draw in the overlay, at the top centre of the tab, through
// main's per-window presenter. Rich messages, and any toast the overlay can't
// draw (before it is ready, or after it failed), show here in the chrome.

type Invoke = (service: 'toasts', method: 'show' | 'dismiss', ...args: unknown[]) => Promise<unknown>

function overlayInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null
  const api = (window as { apex?: { invoke?: unknown } }).apex
  return typeof api?.invoke === 'function' ? (api.invoke as Invoke) : null
}

/** Toasts the overlay is showing, by id; a newer one with the same id replaces the entry. */
const routed = new Map<string, ToastRecord>()

function finish(record: ToastRecord, outcome: ToastOutcome): void {
  if (outcome === 'undo') record.undo?.()
  if (outcome === 'action') record.action?.onAction()
  record.onDismiss?.(reasonFor(outcome))
}

function showRouted(invoke: Invoke, record: ToastRecord, wire: ToastWire & { id: string }): string {
  routed.set(record.id, record)
  let pending: Promise<unknown>
  try {
    pending = Promise.resolve(invoke('toasts', 'show', wire))
  } catch (err) {
    pending = Promise.reject(err)
  }
  pending.then(
    (outcome) => {
      if (routed.get(record.id) !== record) return record.onDismiss?.('replaced')
      routed.delete(record.id)
      // An answer this API doesn't know means nobody drew it: show it here instead.
      if (!isToastOutcome(outcome)) return void showLocal(record)
      finish(record, outcome)
    },
    () => {
      if (routed.get(record.id) !== record) return record.onDismiss?.('replaced')
      routed.delete(record.id)
      showLocal(record)
    },
  )
  return record.id
}

export { reasonFor, toastWire }

export const toast: ToastApi = {
  show(options) {
    const record = { ...options, id: options.id ?? uniqueId('toast') }
    const invoke = overlayInvoke()
    const wire = invoke ? toastWire(record) : null
    // A toast already showing here is replaced here, so it doesn't jump surfaces.
    if (!invoke || !wire || queue.items().some((r) => r.id === record.id)) return showLocal(record)
    return showRouted(invoke, record, wire)
  },
  dismiss(id) {
    const invoke = overlayInvoke()
    if (routed.has(id) && invoke) {
      void Promise.resolve(invoke('toasts', 'dismiss', id)).catch(() => undefined)
      return
    }
    close(id, 'closed')
  },
}

// Main's own toasts land here when the overlay can't draw them; how each ends goes back to main.
const FALLBACK_REASON: Record<ToastDismissReason, ToastOutcome> = { timeout: 'timeout', closed: 'closed', action: 'action', undo: 'undo', replaced: 'replaced', overflow: 'closed' }

function useMainFallbackToasts(): void {
  useEffect(() => {
    const apex = typeof window === 'undefined' ? undefined : window.apex
    if (typeof apex?.onAppEvent !== 'function') return
    return apex.onAppEvent((event) => {
      if (event.type !== 'toast-fallback') return
      const wire = event.toast
      let reported = false
      const report = (reason: ToastDismissReason): void => {
        if (reported) return
        reported = true
        void Promise.resolve(apex.invoke('toasts', 'outcome', wire.id, FALLBACK_REASON[reason])).catch(() => undefined)
      }
      showLocal({
        id: `main:${wire.id}`,
        message: wire.detail ? (
          <>
            {wire.text}
            <span className="ui-toast__detail">{wire.detail}</span>
          </>
        ) : (
          wire.text
        ),
        tone: wire.kind,
        ...(wire.undo ? { undo: () => undefined } : {}),
        ...(wire.action ? { action: { label: wire.action.label, onAction: () => undefined } } : {}),
        duration: toastTiming(wire),
        onDismiss: report,
      })
    })
  }, [])
}

export function useToast(): ToastApi {
  return toast
}

const TONE_ICON: Record<ToastTone, ReactNode> = {
  neutral: null,
  success: <CircleCheck />,
  error: <CircleAlert />,
  info: <Info />,
}

function ToastItem({ record, paused, phase }: { record: ToastRecord; paused: boolean; phase: PresencePhase }): ReactElement {
  const duration = record.duration ?? toastTiming({ kind: record.tone === 'error' ? 'error' : 'info', undo: !!record.undo, action: record.action ? { id: 'action', label: record.action.label } : undefined })
  const remaining = useRef(duration)
  const leaving = phase === 'exit'
  // Restart the countdown when the toast is replaced in place.
  useEffect(() => {
    remaining.current = duration
  }, [record])
  useEffect(() => {
    if (paused || duration === 0 || leaving) return
    const started = Date.now()
    const timer = setTimeout(() => close(record.id, 'timeout'), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(800, remaining.current - (Date.now() - started))
    }
  }, [paused, record, duration, leaving])

  const tone = record.tone ?? 'neutral'
  return (
    <div role={leaving ? undefined : tone === 'error' ? 'alert' : 'status'} className={cx('ui-toast', `ui-toast--${tone}`)} data-phase={phase} inert={leaving || undefined}>
      {TONE_ICON[tone] && <span className="ui-toast__icon">{TONE_ICON[tone]}</span>}
      <div className="ui-toast__message">{record.message}</div>
      {record.undo && (
        <Button
          size="sm"
          variant="ghost"
          className="ui-toast__action"
          onClick={() => {
            record.undo?.()
            close(record.id, 'undo')
          }}
        >
          {t('menus.toast.undo')}
        </Button>
      )}
      {record.action && (
        <Button
          size="sm"
          variant="ghost"
          className="ui-toast__action"
          onClick={() => {
            record.action?.onAction()
            close(record.id, 'action')
          }}
        >
          {record.action.label}
        </Button>
      )}
      <IconButton size="sm" label={t('menus.toast.dismiss')} tooltip={false} icon={<X />} className="ui-toast__close" onClick={() => close(record.id, 'closed')} />
    </div>
  )
}

export type ToastPlacement = 'bottom-left' | 'bottom-center' | 'bottom-right'

export interface ToastHostProps {
  /**
   * Where the stack sits. Fine-tune with --toast-inset-x, --toast-inset-bottom
   * and --toast-max-width on :root (e.g. to keep it inside the sidebar).
   */
  placement?: ToastPlacement
  /** Set when the stack overlaps a web page; page views hide while toasts show. */
  coversPage?: boolean
}

/** Renders toasts at the bottom of the window. Mount once, near the root. */
export function ToastHost({ placement = 'bottom-left', coversPage = false }: ToastHostProps): ReactElement {
  const list = useSyncExternalStore(queue.subscribe, queue.items)
  // Toasts that leave stay a moment to fold away.
  const entries = usePresenceList(list, (r) => r.id)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  useOverlay(coversPage && entries.length > 0)
  useMainFallbackToasts()

  return createPortal(
    <section
      aria-label={t('menus.toast.region')}
      className={cx('ui-toasts', `ui-toasts--${placement}`)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(e) => {
        const last = list[list.length - 1]
        if (e.key === 'Escape' && last) {
          e.preventDefault()
          close(last.id, 'closed')
        }
      }}
    >
      {entries.map((entry) => (
        <ToastItem key={entry.key} record={entry.item} phase={entry.phase} paused={hovered || focused} />
      ))}
    </section>,
    document.body,
  )
}
