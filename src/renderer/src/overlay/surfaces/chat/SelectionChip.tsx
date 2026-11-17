/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, Copy, MessageCircle, Search, Sparkles } from 'lucide-react'
import type { SelectionChipAction, SelectionChipProps } from '@shared/overlay/chat'
import { useT } from '../../../i18n/useT'
import type { SurfaceComponentProps } from '../../types'
import './atWork.css'

// OV-20: the small chip beside a text selection: ask the companion, explain,
// copy and search, with the ⌘J hint. Main runs the action it resolves with.
// Arrow keys move between the actions; Escape closes it (the host's policy).

const ACTIONS: { id: SelectionChipAction; icon: typeof Copy }[] = [
  { id: 'ask', icon: MessageCircle },
  { id: 'explain', icon: Sparkles },
  { id: 'copy', icon: Copy },
  { id: 'search', icon: Search },
]

export function SelectionChip({ props, resolve, exiting }: SurfaceComponentProps<SelectionChipProps>): ReactElement {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const row = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => resolve('copy'), 500)
    return () => clearTimeout(timer)
  }, [copied])

  const labelOf = (id: SelectionChipAction): string => {
    switch (id) {
      case 'ask':
        return t('atWork.selection.ask', { name: props.companionName })
      case 'explain':
        return t('atWork.selection.explain')
      case 'copy':
        return copied ? t('atWork.selection.copied') : t('atWork.selection.copy')
      case 'search':
        return t('atWork.selection.search')
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const buttons = Array.from(row.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[(at + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]
    e.preventDefault()
    next?.focus()
  }

  return (
    <div className="at-chip" data-exiting={exiting || undefined} role="toolbar" aria-label={t('atWork.selection.label')} ref={row} onKeyDown={onKey}>
      {ACTIONS.map(({ id, icon: Icon }, i) => {
        const label = labelOf(id)
        const shown = id === 'copy' && copied ? Check : Icon
        const Glyph = shown
        return (
          <button
            key={id}
            type="button"
            className={id === 'ask' ? 'at-chip__btn at-chip__btn--ask' : 'at-chip__btn'}
            data-autofocus={i === 0 ? '' : undefined}
            onClick={() => (id === 'copy' ? setCopied(true) : resolve(id))}
            aria-label={label}
            title={label}
          >
            <Glyph aria-hidden="true" />
            {id === 'ask' && <span>{label}</span>}
          </button>
        )
      })}
      {props.shortcut && (
        <span className="at-chip__hint" aria-hidden="true">
          {t('atWork.selection.hint', { keys: props.shortcut })}
        </span>
      )}
    </div>
  )
}
