/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { cx, resolveRename } from './logic/format'
import { useT } from '../i18n/useT'

export interface InlineRenameProps {
  value: string
  /** Called with the trimmed new name; nothing is called for an empty or unchanged one. A rejected promise keeps the field open. */
  onCommit(next: string): void | Promise<unknown>
  /** Accessible name for the field, e.g. "Chat title". */
  label: string
  /** Controlled editing, e.g. started from a menu's Rename item. */
  editing?: boolean
  onEditingChange?(editing: boolean): void
  /** What starts editing from the text itself; 'none' when only a menu does. */
  activation?: 'click' | 'double-click' | 'none'
  /** Shown when the value is empty, e.g. "New chat". */
  placeholder?: string
  maxLength?: number
  className?: string
}

/**
 * Text that turns into a field: click (or Enter / F2 when focused) to edit,
 * Enter or leaving the field saves, Esc cancels. Keys and clicks inside the
 * field don't reach the row around it.
 */
export function InlineRename({ value, onCommit, label, editing: controlled, onEditingChange, activation = 'click', placeholder, maxLength, className }: InlineRenameProps): ReactElement {
  const t = useT()
  const [own, setOwn] = useState(false)
  const editing = controlled ?? own
  const [pending, setPending] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const display = useRef<HTMLSpanElement>(null)
  const done = useRef(false)

  const setEditing = (next: boolean): void => {
    setOwn(next)
    onEditingChange?.(next)
  }

  useEffect(() => {
    if (!editing) return
    done.current = false
    setInvalid(false)
    const el = input.current
    el?.focus()
    el?.select()
  }, [editing])

  const finish = (refocus: boolean): void => {
    done.current = true
    setEditing(false)
    // Give focus back to the text so keyboard users keep their place.
    if (refocus) requestAnimationFrame(() => display.current?.focus())
  }

  const commit = async (refocus: boolean): Promise<void> => {
    if (done.current || pending) return
    const next = resolveRename(value, input.current?.value ?? value, maxLength)
    if (next === null) return finish(refocus)
    setPending(true)
    try {
      await onCommit(next)
      finish(refocus)
    } catch {
      setInvalid(true)
      input.current?.focus()
    } finally {
      setPending(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={input}
        className={cx('ui-rename__input', className)}
        aria-label={label}
        aria-invalid={invalid || undefined}
        defaultValue={value}
        placeholder={placeholder}
        maxLength={maxLength}
        readOnly={pending}
        spellCheck={false}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(true)
          } else if (e.key === 'Escape') {
            // preventDefault tells an open dialog not to close on this Esc.
            e.preventDefault()
            finish(true)
          }
        }}
        onBlur={() => void commit(false)}
      />
    )
  }

  const interactive = activation !== 'none'
  const start = (): void => setEditing(true)
  return (
    <span
      ref={display}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={interactive ? `${label}: ${value || placeholder || ''}. Rename` : undefined}
      title={interactive ? t('core.inlineRename.rename') : undefined}
      className={cx('ui-rename', interactive && 'ui-rename--interactive', !value && 'ui-rename--empty', className)}
      onClick={activation === 'click' ? start : undefined}
      onDoubleClick={activation === 'double-click' ? start : undefined}
      onKeyDown={(e) => {
        if (!interactive) return
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault()
          e.stopPropagation()
          start()
        }
      }}
    >
      {value || placeholder}
    </span>
  )
}
