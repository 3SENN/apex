/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { dialog as nativeDialog } from 'electron'
import { z } from 'zod'
import type { DialogResult, DialogShowOptions, DialogSpec, DialogSurfaceProps, ToastOutcome, ToastSpec, ToastSurfaceProps, ToastWire } from '@shared/dialogs'
import type { OverlayResult, Rect, SurfaceAnchor } from '@shared/overlay'
import { toCssPx } from '@shared/overlayLayout'
import { toastTiming } from '@shared/toastTiming'
import { DialogQueue, type QueuedDialog } from './dialogQueue'
import type { WindowContext } from './features/types'
import { log } from './log'

// Main's dialogs and toasts (OV-05, OV-07). One dialog at a time
// per window, others queue and duplicates by dedupeKey are dropped. Each is
// drawn by the overlay host's `dialog` surface; when the host can't (not
// ready yet, or a crashed or stuck renderer) the chrome draws the same dialog
// itself, and as a last resort a native message box asks.

// The chrome hears this and draws the dialog or toast itself.
const NOT_AVAILABLE = 'The overlay host is not ready'

export const dialogResultSchema = z
  .object({
    button: z.string().max(64).nullable(),
    inputs: z.record(z.string().max(64), z.string().max(10_000)),
    checked: z.boolean(),
  })
  .strict()

const toastOutcomeSchema = z.enum(['undo', 'action', 'timeout', 'closed', 'replaced', 'tab-switch'])

/** What Esc, the close button and a backdrop click answer: the dialog's cancel button, else nothing. */
export function cancelResult(spec: DialogSpec): DialogResult {
  return { button: spec.buttons.find((b) => b.escape)?.id ?? null, inputs: {}, checked: spec.checkbox?.checked ?? false }
}

/** The button a plain confirm treats as yes: the Enter one, else the primary or destructive one. */
export function confirmButton(spec: DialogSpec): string | undefined {
  return (spec.buttons.find((b) => b.enter) ?? spec.buttons.find((b) => b.style === 'primary' || b.style === 'destructive'))?.id
}

const DISMISSED: DialogResult = { button: null, inputs: {}, checked: false }

interface Pending {
  spec: DialogSpec
  opts: DialogShowOptions
  origin: string | null
  /** Chrome-opened dialogs reject instead of falling back, so the chrome draws its own. */
  fromChrome: boolean
  settle(result: DialogResult | Error): void
  /** Duplicates dropped onto this one get its answer too. */
  sharers: ((result: DialogResult) => void)[]
  instanceId: string | null
  fallbackId: string | null
  timer: NodeJS.Timeout | null
}

/** A dialog that is showing or waiting; cancel() answers it as dismissed. */
export interface DialogHandle {
  id: string
  result: Promise<DialogResult>
}

class WindowDialogs {
  readonly #win: WindowContext
  readonly #queue = new DialogQueue<Pending>()
  #pumpQueued = false

  constructor(win: WindowContext) {
    this.#win = win
    const pump = (): void => this.#schedulePump()
    win.tabs.on('activated', pump)
    win.tabs.on('changed', pump)
    win.tabs.on('closed', (tab) => {
      for (const d of this.#queue.forTab(tab.id)) this.cancel(d.id)
    })
    // A tab dialog that asked for it closes when focus leaves the window.
    win.window.on('blur', () => {
      for (const d of this.#queue.all()) if (d.tabId && d.payload.opts.closeOnBlur && this.#queue.isActive(d.id)) this.cancel(d.id, cancelResult(d.payload.spec))
    })
  }

  open(spec: DialogSpec, opts: DialogShowOptions, extra: { origin?: string | null; fromChrome?: boolean } = {}): DialogHandle {
    const id = randomUUID()
    let settle!: (result: DialogResult | Error) => void
    const result = new Promise<DialogResult>((resolve, reject) => {
      settle = (r) => (r instanceof Error ? reject(r) : resolve(r))
    })
    const pending: Pending = { spec, opts, origin: extra.origin ?? null, fromChrome: extra.fromChrome ?? false, settle, sharers: [], instanceId: null, fallbackId: null, timer: null }
    const pushed = this.#queue.push({ id, tabId: opts.tabId ?? null, dedupeKey: spec.dedupeKey, payload: pending })
    if (!pushed.accepted) {
      const same = this.#queue.get(pushed.sameAs)
      same?.payload.sharers.push((r) => settle(r))
      return { id: pushed.sameAs, result }
    }
    if (opts.timeoutMs) pending.timer = setTimeout(() => this.cancel(id), opts.timeoutMs)
    this.#schedulePump()
    return { id, result }
  }

  /** Answers a dialog (showing or waiting) and closes it; the default answer is "dismissed". */
  cancel(id: string, result: DialogResult = DISMISSED): void {
    const item = this.#queue.get(id)
    if (!item) return
    const { instanceId, fallbackId } = item.payload
    this.#finish(item, result)
    if (instanceId) this.#win.overlay.close(instanceId)
    if (fallbackId) this.#win.send({ type: 'dialog-fallback-close', id: fallbackId })
  }

  cancelTab(tabId: string): void {
    for (const d of this.#queue.forTab(tabId)) this.cancel(d.id)
  }

  /** The chrome's fallback dialog answered. */
  answer(fallbackId: string, result: DialogResult): void {
    const item = this.#queue.all().find((d) => d.payload.fallbackId === fallbackId)
    if (item) this.#finish(item, sanitize(item.payload.spec, result))
  }

  pendingFor(tabId: string): boolean {
    return this.#queue.forTab(tabId).length > 0
  }

  #finish(item: QueuedDialog<Pending>, result: DialogResult | Error): void {
    if (!this.#queue.remove(item.id)) return
    const p = item.payload
    if (p.timer) clearTimeout(p.timer)
    p.settle(result)
    for (const share of p.sharers) share(result instanceof Error ? DISMISSED : result)
    this.#schedulePump()
  }

  #schedulePump(): void {
    if (this.#pumpQueued) return
    this.#pumpQueued = true
    queueMicrotask(() => {
      this.#pumpQueued = false
      if (this.#win.window.isDestroyed()) return
      let next: QueuedDialog<Pending> | null
      while ((next = this.#queue.next(this.#win.tabs.visibleIds()))) void this.#present(next)
    })
  }

  async #present(item: QueuedDialog<Pending>): Promise<void> {
    const p = item.payload
    const props: DialogSurfaceProps = { spec: p.spec, scope: item.tabId ? 'tab' : 'window', area: areaOf(this.#win, item.tabId), ...(p.origin ? { origin: p.origin } : {}) }
    const anchor: SurfaceAnchor = item.tabId ? { kind: 'tab', tabId: item.tabId, rect: null } : { kind: 'window', rect: props.area }
    let outcome: OverlayResult
    try {
      const opened = openTracked(this.#win, 'dialog', anchor, props, item.tabId)
      p.instanceId = opened.instanceId
      outcome = await opened.result
    } catch (err) {
      if (!this.#queue.get(item.id)) return
      if (p.fromChrome) return this.#finish(item, new Error(NOT_AVAILABLE))
      log.debug('dialogs', 'Overlay unavailable, the chrome draws the dialog', { error: err instanceof Error ? err.message : String(err) })
      return this.#fallback(item)
    }
    if (!this.#queue.get(item.id)) return
    if ('value' in outcome) {
      const parsed = dialogResultSchema.safeParse(outcome.value)
      return this.#finish(item, parsed.success ? sanitize(p.spec, parsed.data) : cancelResult(p.spec))
    }
    // A surface that crashed or never mounted gets the plain fallback (OV-07).
    if (outcome.dismissed === 'crashed' || outcome.dismissed === 'timeout') {
      if (p.fromChrome) return this.#finish(item, new Error(NOT_AVAILABLE))
      return this.#fallback(item)
    }
    const userCancel = outcome.dismissed === 'escape' || outcome.dismissed === 'outside' || outcome.dismissed === 'closed'
    this.#finish(item, userCancel ? cancelResult(p.spec) : DISMISSED)
  }

  /** The chrome draws it (ui/Confirm's fallback host); if the chrome is gone, a native box asks. */
  #fallback(item: QueuedDialog<Pending>): void {
    const p = item.payload
    const chrome = this.#win.chrome
    if (!chrome.isDestroyed() && !chrome.isCrashed()) {
      p.fallbackId = item.id
      this.#win.send({ type: 'dialog-fallback', id: item.id, spec: p.spec, tabId: item.tabId, origin: p.origin })
      return
    }
    void nativeFallback(this.#win, p.spec).then((result) => {
      if (this.#queue.get(item.id)) this.#finish(item, result)
    })
  }
}

/** Keeps answers to what the spec offered: a known button, its own inputs. */
function sanitize(spec: DialogSpec, result: DialogResult): DialogResult {
  const button = result.button !== null && spec.buttons.some((b) => b.id === result.button) ? result.button : null
  const inputs: Record<string, string> = {}
  for (const input of spec.inputs ?? []) inputs[input.id] = result.inputs[input.id] ?? input.value ?? ''
  return { button, inputs, checked: spec.checkbox ? result.checked : false }
}

/** A native box for button-only dialogs; one that needs typing is cancelled instead. */
async function nativeFallback(win: WindowContext, spec: DialogSpec): Promise<DialogResult> {
  if (spec.inputs?.length || win.window.isDestroyed()) return cancelResult(spec)
  const buttons = spec.buttons
  const escape = buttons.findIndex((b) => b.escape)
  const enter = buttons.findIndex((b) => b.enter)
  const answer = await nativeDialog.showMessageBox(win.window, {
    type: spec.icon === 'danger' || spec.icon === 'warning' ? 'warning' : 'none',
    message: spec.title,
    detail: [spec.description, spec.callout].filter(Boolean).join('\n\n') || undefined,
    buttons: buttons.map((b) => b.label),
    cancelId: escape >= 0 ? escape : undefined,
    defaultId: enter >= 0 ? enter : undefined,
    checkboxLabel: spec.checkbox?.label,
    checkboxChecked: spec.checkbox?.checked,
  })
  return { button: buttons[answer.response]?.id ?? null, inputs: {}, checked: answer.checkboxChecked }
}

/** A tab's pane, or the window's content area, in chrome CSS px: where a surface's backdrop goes. */
export function areaOf(win: WindowContext, tabId: string | null): Rect {
  const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
  const pane = tabId ? win.tabs.paneBounds(tabId) : null
  if (pane) return toCssPx(pane, zoom)
  if (win.window.isDestroyed()) return { x: 0, y: 0, width: 0, height: 0 }
  const { width, height } = win.window.getContentBounds()
  return toCssPx({ x: 0, y: 0, width, height }, zoom)
}

/**
 * Opens a surface and learns its instance id, so main can close or update it
 * later (OverlayHost.open only resolves with the result).
 */
export function openTracked<S extends 'dialog' | 'toast' | 'qr-code' | 'task-manager'>(
  win: WindowContext,
  surface: S,
  anchor: SurfaceAnchor,
  props: S extends 'dialog' ? DialogSurfaceProps : S extends 'toast' ? ToastSurfaceProps : unknown,
  tabId: string | null,
): { instanceId: string | null; result: Promise<OverlayResult> } {
  const host = win.overlay as typeof win.overlay & { openSurfaces?: () => { instanceId: string; surface: string }[] }
  const before = new Set((host.openSurfaces?.() ?? []).map((s) => s.instanceId))
  const result = win.overlay.open(surface, anchor, props as never, tabId ? { tabId } : undefined)
  const added = (host.openSurfaces?.() ?? []).find((s) => s.surface === surface && !before.has(s.instanceId))
  return { instanceId: added?.instanceId ?? null, result }
}

const perWindow = new Map<number, WindowDialogs>()

function forWindow(win: WindowContext): WindowDialogs {
  let d = perWindow.get(win.id)
  if (!d) {
    d = new WindowDialogs(win)
    perWindow.set(win.id, d)
    win.window.once('closed', () => perWindow.delete(win.id))
  }
  return d
}

export const dialogs = {
  show(win: WindowContext, spec: DialogSpec, opts: DialogShowOptions = {}): Promise<DialogResult> {
    return forWindow(win).open(spec, opts).result
  },
  /** Like show, but the caller can cancel it (page dialogs on navigation, sign-in on a closed request). */
  open(win: WindowContext, spec: DialogSpec, opts: DialogShowOptions = {}, extra: { origin?: string | null; fromChrome?: boolean } = {}): DialogHandle {
    return forWindow(win).open(spec, opts, extra)
  },
  cancel(win: WindowContext, id: string): void {
    forWindow(win).cancel(id)
  },
  cancelTab(win: WindowContext, tabId: string): void {
    forWindow(win).cancelTab(tabId)
  },
  answer(win: WindowContext, fallbackId: string, result: DialogResult): void {
    forWindow(win).answer(fallbackId, result)
  },
  /** A page dialog is waiting on this tab (the unresponsive-page notice stays away meanwhile). */
  pendingFor(win: WindowContext, tabId: string): boolean {
    return forWindow(win).pendingFor(tabId)
  },
  async confirm(win: WindowContext, spec: DialogSpec, opts?: DialogShowOptions): Promise<boolean> {
    const result = await dialogs.show(win, spec, opts)
    return result.button !== null && result.button === confirmButton(spec)
  },
  async alert(win: WindowContext, spec: DialogSpec, opts?: DialogShowOptions): Promise<void> {
    await dialogs.show(win, spec, opts)
  },
}

// ---- toasts (OV-05) ----

/** About two seconds (OV-05); longer when there is something to press or read. */
export const toastDuration = toastTiming

interface ShownToast {
  id: string
  instanceId: string | null
  settle(outcome: ToastOutcome): void
}

const shownToasts = new Map<number, ShownToast>()
const fallbackToasts = new Map<string, (outcome: ToastOutcome) => void>()

function dismissalOutcome(reason: string): ToastOutcome {
  return reason === 'replaced' ? 'replaced' : reason === 'tab-switch' ? 'tab-switch' : 'closed'
}

/** Shows a toast at the top centre of the tab and resolves with how it ended. */
function presentToast(win: WindowContext, wire: ToastWire & { id: string }, fromChrome: boolean): Promise<ToastOutcome> {
  const tabId = wire.tabId ?? win.tabs.activeId() ?? null
  const props: ToastSurfaceProps = { toast: { ...wire, ...(tabId ? { tabId } : {}) }, area: areaOf(win, tabId) }
  const current = shownToasts.get(win.id)
  // The same id replaces the toast in place ("Saving…" then "Saved").
  if (current && current.id === wire.id && current.instanceId) {
    win.overlay.update(current.instanceId, props)
    return new Promise((resolve) => {
      const previous = current.settle
      current.settle = (o) => {
        previous('replaced')
        resolve(o)
      }
    })
  }
  return new Promise((resolve, reject) => {
    const anchor: SurfaceAnchor = tabId && win.tabs.paneBounds(tabId) ? { kind: 'tab', tabId, rect: null } : { kind: 'window', rect: props.area }
    let opened: ReturnType<typeof openTracked>
    try {
      opened = openTracked(win, 'toast', anchor, props, tabId)
    } catch (err) {
      return fromChrome ? reject(err instanceof Error ? err : new Error(NOT_AVAILABLE)) : resolve(chromeToast(win, props.toast))
    }
    const entry: ShownToast = { id: wire.id, instanceId: opened.instanceId, settle: resolve }
    shownToasts.set(win.id, entry)
    opened.result.then(
      (r) => {
        if (shownToasts.get(win.id) === entry) shownToasts.delete(win.id)
        if ('value' in r) {
          const parsed = toastOutcomeSchema.safeParse(r.value)
          entry.settle(parsed.success ? parsed.data : 'closed')
        } else if ((r.dismissed === 'crashed' || r.dismissed === 'timeout') && !fromChrome) void chromeToast(win, props.toast).then(entry.settle)
        else entry.settle(dismissalOutcome(r.dismissed))
      },
      (err: unknown) => {
        if (shownToasts.get(win.id) === entry) shownToasts.delete(win.id)
        if (fromChrome) reject(err instanceof Error ? err : new Error(NOT_AVAILABLE))
        else void chromeToast(win, props.toast).then(entry.settle)
      },
    )
  })
}

/** The chrome's own toast host shows it (before the overlay host is ready); it reports back through toasts.outcome. */
function chromeToast(win: WindowContext, toast: ToastWire & { id: string }): Promise<ToastOutcome> {
  if (win.chrome.isDestroyed()) return Promise.resolve('closed')
  return new Promise((resolve) => {
    fallbackToasts.get(toast.id)?.('replaced')
    fallbackToasts.set(toast.id, resolve)
    win.send({ type: 'toast-fallback', toast })
    // Never wait forever on a chrome that reloaded meanwhile.
    setTimeout(() => {
      if (fallbackToasts.get(toast.id) === resolve) {
        fallbackToasts.delete(toast.id)
        resolve('closed')
      }
    }, toastDuration(toast) + 30_000).unref?.()
  })
}

export const toasts = {
  /** Shows a toast; undo and the action run here when pressed. */
  show(win: WindowContext, spec: ToastSpec): Promise<ToastOutcome> {
    const { undo, ...rest } = spec
    const wire: ToastWire & { id: string } = { ...rest, id: randomUUID(), ...(undo ? { undo: true } : {}) }
    return presentToast(win, wire, false).then((outcome) => {
      if (outcome === 'undo' && undo) {
        Promise.resolve()
          .then(undo)
          .catch((err: unknown) => log.warn('dialogs', 'Undo failed', { error: err instanceof Error ? err.message : String(err) }))
      }
      return outcome
    })
  },
  /** The chrome's toast (ui/Toast): rejects when the overlay can't draw it, so the chrome shows its own. */
  showFromChrome(win: WindowContext, wire: ToastWire): Promise<ToastOutcome> {
    return presentToast(win, { ...wire, id: wire.id ?? randomUUID() }, true)
  },
  dismiss(win: WindowContext, id: string): void {
    const current = shownToasts.get(win.id)
    if (current?.id === id && current.instanceId) win.overlay.close(current.instanceId)
  },
  /** The chrome's fallback toast ended. */
  outcome(id: string, outcome: ToastOutcome): void {
    const settle = fallbackToasts.get(id)
    fallbackToasts.delete(id)
    settle?.(outcome)
  },
}
