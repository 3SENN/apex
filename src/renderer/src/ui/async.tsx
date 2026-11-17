/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Async buttons and forms: a spinner while the work runs, no
// second submit, a success toast where it helps and the error inline (or as
// a toast when there is nowhere inline to put it).
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { errorText } from '../api'
import { Button, type ButtonProps } from './Button'
import { useToast } from './Toast'

export interface AsyncActionOptions {
  /** A toast once it succeeds. */
  success?: ReactNode
  /** Show failures as a toast instead of returning them for an inline message. */
  toastErrors?: boolean
}

export interface AsyncAction<A extends unknown[]> {
  /** Runs once at a time; a call while busy is ignored. Resolves true on success. */
  run(...args: A): Promise<boolean>
  busy: boolean
  error: string | null
  clearError(): void
}

/** Wraps an async function with a busy flag, a re-entry guard and the error text. */
export function useAsyncAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, options: AsyncActionOptions = {}): AsyncAction<A> {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const latest = useRef(fn)
  latest.current = fn
  const toast = useToast()
  const run = useCallback(
    async (...args: A): Promise<boolean> => {
      if (running.current) return false
      running.current = true
      setBusy(true)
      setError(null)
      try {
        await latest.current(...args)
        if (options.success) toast.show({ tone: 'success', message: options.success })
        return true
      } catch (err) {
        const text = errorText(err)
        if (options.toastErrors) toast.show({ tone: 'error', message: text })
        else setError(text)
        return false
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [options.success, options.toastErrors],
  )
  return { run, busy, error, clearError: () => setError(null) }
}

export interface AsyncButtonProps extends Omit<ButtonProps, 'onClick' | 'loading'> {
  onClick(): Promise<unknown>
  /** A toast once it succeeds. */
  success?: ReactNode
}

/** A button whose work is async: it spins, refuses a second press, and reports failure as a toast. */
export function AsyncButton({ onClick, success, disabled, ...rest }: AsyncButtonProps): ReactElement {
  const action = useAsyncAction(onClick, { success, toastErrors: true })
  return <Button {...rest} disabled={disabled} loading={action.busy} onClick={() => void action.run()} />
}
