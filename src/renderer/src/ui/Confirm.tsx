/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import type { DialogResult, DialogSpec } from '@shared/dialogs'
import { alertSpec, escapeButton, initialValues, resultFor } from '@shared/dialogLogic'
import { t } from '../i18n/useT'
import { DialogView } from '../overlay/surfaces/menus/dialog/DialogView'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { confirmOptionsSpec, createQueue, uniqueId } from './logic/queues'
import { useOverlay } from './overlay'

export interface ConfirmOptions {
  title: string
  message?: ReactNode
  /** Defaults to "Delete" when destructive, "Continue" otherwise. */
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button, and focus starts on Cancel. */
  destructive?: boolean
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean
  /** Shows a spinner on the confirm button while the action runs. */
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

/** A controlled yes/no dialog. Most callers want useConfirm() instead. */
export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel = t('menus.dialog.cancel'), destructive = false, busy = false, onConfirm, onCancel }: ConfirmDialogProps): ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={message}
      size="sm"
      hideClose
      role="alertdialog"
      dismissible={!busy}
      initialFocus={destructive ? cancelRef : confirmRef}
      footer={
        <>
          <Button ref={cancelRef} variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel ?? (destructive ? t('menus.confirm.delete') : t('menus.confirm.continue'))}
          </Button>
        </>
      }
    />
  )
}

interface PendingConfirm extends ConfirmOptions {
  id: string
  resolve(ok: boolean): void
}

const requests = createQueue<PendingConfirm>()
let hosts = 0

function plainText(node: ReactNode): string {
  return typeof node === 'string' || typeof node === 'number' ? String(node) : ''
}

// OV-07, OV-08: confirmations and alerts draw in the overlay's `dialog`
// surface through main's per-window queue (one at a time, duplicates
// dropped). A rich message, or a dialog the overlay can't draw, shows here
// in the chrome instead; without a host the native box asks, so nothing
// destructive ever runs unasked.

type Invoke = (service: 'dialogs', method: 'show' | 'answer', ...args: unknown[]) => Promise<unknown>

function overlayInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null
  const api = (window as { atelier?: { invoke?: unknown } }).atelier
  return typeof api?.invoke === 'function' ? (api.invoke as Invoke) : null
}

function isResult(value: unknown): value is DialogResult {
  return !!value && typeof value === 'object' && 'button' in value && (typeof (value as DialogResult).button === 'string' || (value as DialogResult).button === null)
}

/** Asks main to show a spec; resolves null when the overlay can't (the caller then asks here). */
function showInOverlay(spec: DialogSpec): Promise<DialogResult | null> {
  const invoke = overlayInvoke()
  if (!invoke) return Promise.resolve(null)
  try {
    return Promise.resolve(invoke('dialogs', 'show', spec)).then(
      (r) => (isResult(r) ? r : null),
      () => null,
    )
  } catch {
    return Promise.resolve(null)
  }
}

function confirmHere(options: ConfirmOptions): Promise<boolean> {
  if (hosts === 0) {
    const text = [options.title, plainText(options.message)].filter(Boolean).join('\n\n')
    return Promise.resolve(window.confirm(text))
  }
  return new Promise((resolve) => {
    requests.push({ ...options, id: uniqueId('confirm'), resolve })
  })
}

/**
 * Asks a yes/no question and resolves with the answer. Drawn by the overlay
 * when it can; otherwise by <ConfirmHost/> (inside <UiHost/>), and without a
 * host by the native confirm.
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  const spec = confirmOptionsSpec(options)
  if (!spec) return confirmHere(options)
  return showInOverlay(spec).then((result) => (result ? result.button === 'confirm' : confirmHere(options)))
}

export { confirmOptionsSpec }

/** Returns confirm(); `if (await confirm({ title, destructive: true })) remove()`. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirm
}

export interface AlertOptions {
  title: string
  message?: string
  okLabel?: string
  icon?: DialogSpec['icon']
}

/** Tells the person something and resolves once they close it (OV-08). */
export function alert(options: AlertOptions): Promise<void> {
  const spec = alertSpec({ title: options.title, ...(options.message ? { message: options.message } : {}), okLabel: options.okLabel ?? t('menus.dialog.ok'), ...(options.icon ? { icon: options.icon } : {}) })
  return showInOverlay(spec).then((result) => {
    if (result) return
    if (hosts === 0) {
      window.alert([options.title, options.message].filter(Boolean).join('\n\n'))
      return
    }
    return new Promise<void>((resolve) => {
      specs.push({ id: uniqueId('alert'), spec, origin: null, answer: () => resolve() })
    })
  })
}

// Dialogs main hands to the chrome when the overlay can't draw them, and the chrome's own alerts.
interface PendingSpec {
  id: string
  spec: DialogSpec
  origin: string | null
  answer(result: DialogResult): void
}

const specs = createQueue<PendingSpec>()

function useMainFallbackDialogs(): void {
  useEffect(() => {
    const atelier = typeof window === 'undefined' ? undefined : window.atelier
    if (typeof atelier?.onAppEvent !== 'function') return
    return atelier.onAppEvent((event) => {
      if (event.type === 'dialog-fallback') {
        const { id, spec, origin } = event
        specs.push({ id: `main:${id}`, spec, origin, answer: (result) => void Promise.resolve(atelier.invoke('dialogs', 'answer', id, result)).catch(() => undefined) })
      } else if (event.type === 'dialog-fallback-close') {
        specs.remove(`main:${event.id}`)
      }
    })
  }, [])
}

/** One spec dialog drawn in the chrome, over a scrim that cancels like Esc. */
function ChromeSpecDialog({ item, onDone }: { item: PendingSpec; onDone(result: DialogResult): void }): ReactElement {
  useOverlay(true)
  const cancel = (): void => onDone(resultFor(item.spec, escapeButton(item.spec), initialValues(item.spec), item.spec.checkbox?.checked ?? false))
  return (
    <div className="dlg-layer dlg-layer--chrome" data-scope="window" data-state="open">
      <div className="dlg-layer__scrim" aria-hidden onPointerDown={cancel} />
      <DialogView spec={item.spec} origin={item.origin} onAnswer={onDone} />
    </div>
  )
}

/** Shows queued confirmations one at a time. Mount once, near the root. */
export function ConfirmHost(): ReactElement | null {
  const list = useSyncExternalStore(requests.subscribe, requests.items)
  const specList = useSyncExternalStore(specs.subscribe, specs.items)
  useMainFallbackDialogs()
  useEffect(() => {
    hosts++
    return () => {
      hosts--
    }
  }, [])
  const spec = specList[0]
  if (spec) {
    const done = (result: DialogResult): void => {
      if (!specs.remove(spec.id)) return
      spec.answer(result)
    }
    return <ChromeSpecDialog key={spec.id} item={spec} onDone={done} />
  }
  const current = list[0]
  if (!current) return null
  const answer = (ok: boolean): void => {
    requests.remove(current.id)
    current.resolve(ok)
  }
  return <ConfirmDialog key={current.id} open {...current} onConfirm={() => answer(true)} onCancel={() => answer(false)} />
}
