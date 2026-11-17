/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { cx } from '../ui'
import './updates.css'

// The frame every update card shares. The overlay host places it (each
// module's placement: centred for questions, the window's bottom-right corner
// for what's new, placed again when the window resizes) and sizes its view to
// it, and moves focus into the modal ones; the frame keeps Tab inside a modal
// and lets Esc dismiss it.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface CardFrameProps {
  modal: boolean
  labelledBy: string
  describedBy?: string
  exiting: boolean
  className?: string
  onEscape(): void
  children: ReactNode
}

export function CardFrame({ modal, labelledBy, describedBy, exiting, className, onEscape, children }: CardFrameProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onEscape()
      return
    }
    // A modal keeps Tab inside itself.
    if (e.key !== 'Tab' || !modal || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      ref={ref}
      role={modal ? 'alertdialog' : 'dialog'}
      aria-modal={modal || undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cx('update-card', modal && 'update-card--modal', className)}
      data-exiting={exiting || undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}
