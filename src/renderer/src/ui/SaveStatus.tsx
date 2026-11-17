/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import { useLatest } from './hooks'
import { Spinner } from './indicators'
import { createAutosave, type Autosave, type SaveState } from './logic/autosave'
import { cx } from './logic/format'
import { useT } from '../i18n/useT'

export type { SaveState } from './logic/autosave'

export interface SaveStatusProps {
  state: SaveState
  /** Shows a Retry link in the error state. */
  onRetry?(): void
  className?: string
}

/** "Saving…", "Saved", or "Couldn't save · Retry", announced politely. */
export function SaveStatus({ state, onRetry, className }: SaveStatusProps): ReactElement {
  const t = useT()
  return (
    <span aria-live="polite" className={cx('ui-save-status', `ui-save-status--${state}`, className)}>
      {state === 'saving' && (
        <>
          <Spinner size={11} /> {t('core.saveStatus.saving')}
        </>
      )}
      {state === 'saved' && (
        <>
          <Check aria-hidden /> {t('core.saveStatus.saved')}
        </>
      )}
      {state === 'error' && (
        <>
          <CircleAlert aria-hidden /> {t('core.saveStatus.couldnTSave')}
          {onRetry && (
            <button type="button" className="ui-save-status__retry" onClick={onRetry}>
              {t('core.saveStatus.retry')}
            </button>
          )}
        </>
      )}
    </span>
  )
}

export interface AutosaveHookOptions {
  /** Quiet time after the last change (default 600 ms). */
  delay?: number
  savedFor?: number
  /** While false, changes are ignored (e.g. before the value has loaded). */
  enabled?: boolean
}

export interface AutosaveHandle {
  state: SaveState
  retry(): void
  /** Saves a pending change now, e.g. on blur. */
  flush(): Promise<void>
}

/**
 * Saves `value` a moment after it stops changing, and on unmount. The first
 * value is treated as already saved. Pass primitives or memoized values: a new
 * object every render counts as a change.
 */
export function useAutosave<T>(value: T, save: (value: T) => Promise<unknown>, options: AutosaveHookOptions = {}): AutosaveHandle {
  const [state, setState] = useState<SaveState>('idle')
  const saveRef = useLatest(save)
  const controller = useRef<Autosave<T> | null>(null)
  const saved = useRef(value)
  const enabled = options.enabled ?? true

  // Created in an effect so StrictMode's mount, unmount, mount leaves a live one.
  useEffect(() => {
    const c = createAutosave<T>({ save: (v) => saveRef.current(v), onState: setState, delay: options.delay, savedFor: options.savedFor })
    controller.current = c
    return () => {
      c.dispose()
      if (controller.current === c) controller.current = null
    }
  }, [])

  useEffect(() => {
    if (Object.is(saved.current, value)) return
    saved.current = value
    if (enabled) controller.current?.change(value)
  }, [value])

  return {
    state,
    retry: () => void controller.current?.retry(),
    flush: () => controller.current?.flush() ?? Promise.resolve(),
  }
}
