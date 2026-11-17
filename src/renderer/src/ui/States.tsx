/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from './Button'
import { cx } from './logic/format'
import { SKELETON_GRACE_MS } from './logic/skeleton'
import { t } from '../i18n/useT'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  /** A circle of `width` (avatars, favicons). */
  circle?: boolean
  className?: string
  style?: CSSProperties
}

/** A placeholder block. Decorative: put aria-busy on the region that is loading. */
export function Skeleton({ width, height = 12, radius, circle, className, style }: SkeletonProps): ReactElement {
  return (
    <span
      aria-hidden
      className={cx('ui-skeleton', className)}
      style={{ width, height: circle ? width : height, borderRadius: circle ? '50%' : radius, ...style }}
    />
  )
}

/** Lines of placeholder text; the last one is shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }): ReactElement {
  return (
    <span aria-hidden className={cx('ui-skeleton-text', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? '62%' : '100%'} />
      ))}
    </span>
  )
}

export interface SkeletonRowsProps {
  rows?: number
  /** A leading circle, for avatar or favicon rows. */
  avatar?: boolean
  /** Announced while loading (default "Loading"). */
  label?: string
  className?: string
}

/**
 * A loading list: a status for assistive tech and a few placeholder rows.
 * DS-106: the rows stay invisible for the first ~100 ms (a fast load never
 * flashes them); data hooks hold content back until a shown skeleton has
 * been up ~100 ms (settings/data.ts useResource, logic/skeleton.ts).
 */
export function SkeletonRows({ rows = 4, avatar = false, label = t('core.states.loading'), className }: SkeletonRowsProps): ReactElement {
  const [graced, setGraced] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setGraced(true), SKELETON_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cx('ui-skeleton-rows', className)} data-grace={graced ? undefined : ''}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="ui-skeleton-row">
          {avatar && <Skeleton circle width={24} />}
          <span className="ui-skeleton-row__lines">
            <Skeleton width={`${72 - ((i * 17) % 30)}%`} />
            <Skeleton width={`${40 - ((i * 11) % 16)}%`} height={10} />
          </span>
        </div>
      ))}
    </div>
  )
}

export interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Usually one Button that fills the list. */
  action?: ReactNode
  /** Tighter spacing for sidebars and popovers. */
  compact?: boolean
  className?: string
}

export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps): ReactElement {
  return (
    <div className={cx('ui-state', compact && 'ui-state--compact', className)}>
      {icon && (
        <span className="ui-state__icon" aria-hidden>
          {icon}
        </span>
      )}
      <p className="ui-state__title">{title}</p>
      {description && <div className="ui-state__description">{description}</div>}
      {action && <div className="ui-state__actions">{action}</div>}
    </div>
  )
}

export interface ErrorStateProps {
  title?: ReactNode
  message?: ReactNode
  /** Shows Try again; a returned promise keeps the button busy until it settles. */
  onRetry?(): void | Promise<unknown>
  retryLabel?: string
  /** A second action, e.g. "New chat". */
  action?: ReactNode
  compact?: boolean
  className?: string
}

export function ErrorState({ title = t('core.states.couldnTLoadThis'), message, onRetry, retryLabel = t('core.states.tryAgain'), action, compact = false, className }: ErrorStateProps): ReactElement {
  const [retrying, setRetrying] = useState(false)
  const retry = async (): Promise<void> => {
    if (!onRetry) return
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div role="alert" className={cx('ui-state', 'ui-state--error', compact && 'ui-state--compact', className)}>
      <span className="ui-state__icon" aria-hidden>
        <TriangleAlert />
      </span>
      <p className="ui-state__title">{title}</p>
      {message && <div className="ui-state__description">{message}</div>}
      {(onRetry || action) && (
        <div className="ui-state__actions">
          {onRetry && (
            <Button variant="secondary" size="sm" loading={retrying} onClick={() => void retry().catch(() => undefined)}>
              {retryLabel}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  )
}
