/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement, ReactNode } from 'react'
import { isMac } from './hooks'
import { cx, formatCount, ringGeometry } from './logic/format'
import { shortcutParts } from './logic/shortcut'
import { t } from '../i18n/useT'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

export interface BadgeProps {
  tone?: BadgeTone
  /** 'soft' is a tinted pill; 'solid' is filled, for counts on icons. */
  variant?: 'soft' | 'solid'
  /** Shows a number instead of children; nothing renders at 0. */
  count?: number
  max?: number
  children?: ReactNode
  title?: string
  className?: string
}

export function Badge({ tone = 'neutral', variant = 'soft', count, max = 99, children, title, className }: BadgeProps): ReactElement | null {
  if (count !== undefined && count <= 0) return null
  return (
    <span title={title} className={cx('ui-badge', `ui-badge--${tone}`, `ui-badge--${variant}`, count !== undefined && 'ui-badge--count', className)}>
      {count !== undefined ? formatCount(count, max) : children}
    </span>
  )
}

export type Status = 'working' | 'needs-input' | 'error' | 'success' | 'unread' | 'idle'

const STATUS_LABELS: Record<Status, string> = {
  get working() { return t('core.indicators.working') },
  get 'needs-input'() { return t('core.indicators.waitingForYou') },
  get error() { return t('core.indicators.stoppedWithAnError') },
  get success() { return t('core.indicators.finished') },
  get unread() { return t('core.indicators.unread') },
  get idle() { return t('core.indicators.idle') },
}

export interface StatusDotProps {
  status: Status
  /** Read out by screen readers; '' hides the dot from them when the row already says it. */
  label?: string
  /** Diameter in px (default 8). */
  size?: number
  /** Pulses; on by default for 'working' and 'needs-input'. Off under reduced motion. */
  pulse?: boolean
  className?: string
}

export function StatusDot({ status, label, size = 8, pulse, className }: StatusDotProps): ReactElement {
  const name = label ?? STATUS_LABELS[status]
  const pulsing = pulse ?? (status === 'working' || status === 'needs-input')
  return (
    <span
      role={name ? 'img' : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      title={name || undefined}
      className={cx('ui-status-dot', `ui-status-dot--${status}`, pulsing && 'ui-status-dot--pulse', className)}
      style={{ width: size, height: size }}
    />
  )
}

export interface SpinnerProps {
  /** Diameter in px (default 14). */
  size?: number
  /** Announced as a status when given; decorative otherwise. */
  label?: string
  className?: string
}

export function Spinner({ size = 14, label, className }: SpinnerProps): ReactElement {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx('ui-spinner', className)}
      style={{ width: size, height: size, borderWidth: Math.max(1.5, Math.round(size / 7)) }}
    />
  )
}

export interface ProgressRingProps {
  /** 0 to 1, or null while the total is unknown (spins). */
  value: number | null
  /** Diameter in px (default 18). */
  size?: number
  stroke?: number
  label?: string
  /** Drawn in the middle, e.g. an icon. */
  children?: ReactNode
  className?: string
}

export function ProgressRing({ value, size = 18, stroke = 2, label, children, className }: ProgressRingProps): ReactElement {
  const { radius, circumference, offset } = ringGeometry(size, stroke, value ?? 0.25)
  const c = size / 2
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100)}
      className={cx('ui-ring', value === null && 'ui-ring--indeterminate', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ui-ring__track" cx={c} cy={c} r={radius} strokeWidth={stroke} fill="none" />
        <circle
          className="ui-ring__value"
          cx={c}
          cy={c}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </svg>
      {children !== undefined && <span className="ui-ring__center">{children}</span>}
    </span>
  )
}

export interface KbdProps {
  /** An Electron accelerator, e.g. 'CmdOrCtrl+Shift+E'. */
  shortcut?: string
  /** Literal keys, when there is no accelerator (e.g. ['↑']). */
  keys?: string[]
  className?: string
}

export function Kbd({ shortcut, keys, className }: KbdProps): ReactElement {
  const parts = keys ?? (shortcut ? shortcutParts(shortcut, isMac) : [])
  return (
    <kbd className={cx('ui-kbd', className)}>
      {parts.map((part, i) => (
        <kbd key={i} className="ui-kbd__key">
          {part}
        </kbd>
      ))}
    </kbd>
  )
}

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { children: ReactNode }): ReactElement {
  return <span className="ui-sr-only">{children}</span>
}
