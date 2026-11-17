/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import { Redo2, Shuffle, Undo2 } from 'lucide-react'
import { IconButton } from '../ui'
import { t } from '../i18n/useT'
import type { LookBinding } from '../pages/CompanionEditor'
import { SHUFFLE_STYLES, type ShuffleStyle } from './logic/shuffle'

// DS-43's look toolbar as one piece: a 40 px hairline pill holding undo and
// redo, a divider, and Apex's four shuffle styles as one-shot pills. The
// Settings look editor uses it in place of the old studio side column (the
// shuffle-style segments, the Shuffle button and the preview-mood select).

const STYLE_KEYS = {
  any: 'coCard.look.style.any',
  soft: 'coCard.look.style.soft',
  bright: 'coCard.look.style.bright',
  bold: 'coCard.look.style.bold',
} as const satisfies Record<ShuffleStyle, string>

/** Arrow keys, Home and End move between the pill's buttons. */
export function onLookToolsKey(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  if (buttons.length === 0) return
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  e.preventDefault()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}

interface LookToolsProps {
  binding: LookBinding
  /** The toolbar's accessible name. */
  label: string
  /** Shuffling needs the part catalogue; off until it has loaded. */
  canShuffle: boolean
  onShuffle(style: ShuffleStyle): void
  /** Extra pills after the styles. */
  children?: ReactNode
  className?: string
}

export function LookTools({ binding, label, canShuffle, onShuffle, children, className }: LookToolsProps): ReactElement {
  return (
    <div className={className ? `co-look__tools ${className}` : 'co-look__tools'} role="toolbar" aria-label={label} onKeyDown={onLookToolsKey}>
      <IconButton label={t('settings.look.undo')} shortcut="CmdOrCtrl+Z" icon={<Undo2 />} className="co-look__tool" disabled={!binding.canUndo} onClick={binding.undo} />
      <IconButton label={t('settings.look.redo')} shortcut="CmdOrCtrl+Shift+Z" icon={<Redo2 />} className="co-look__tool" disabled={!binding.canRedo} onClick={binding.redo} />
      <span className="co-look__divider" aria-hidden />
      {SHUFFLE_STYLES.map((s) => {
        const name = t(STYLE_KEYS[s.id])
        return (
          <button key={s.id} type="button" className="co-look__style" title={t('coCard.look.styleTitle', { style: name })} disabled={!canShuffle} onClick={() => onShuffle(s.id)}>
            {s.id === 'any' && <Shuffle aria-hidden />}
            {name}
          </button>
        )
      })}
      {children}
    </div>
  )
}
