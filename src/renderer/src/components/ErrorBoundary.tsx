/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from '../ui'
import { t } from '../i18n/useT'

interface ErrorBoundaryProps {
  /** Names the part that failed, e.g. "The sidebar". */
  what: string
  children: ReactNode
  /** Changing it clears an error (e.g. the page's address). */
  resetKey?: string
  compact?: boolean
}

interface ErrorBoundaryState {
  error: Error | null
  attempt: number
}

/**
 * One renderer draws the whole chrome, so a failing part must not blank the
 * window: it shows a notice with Retry, which mounts the part again.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`${this.props.what} failed to draw:`, error, info.componentStack)
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  override render(): ReactNode {
    if (!this.state.error) return <ResetKey key={this.state.attempt}>{this.props.children}</ResetKey>
    return (
      <div className={this.props.compact ? 'chrome-error chrome-error--compact' : 'chrome-error'}>
        <ErrorState
          compact={this.props.compact}
          title={t('core.errorBoundary.stoppedWorking', { what: this.props.what })}
          message={t('core.errorBoundary.retryToDrawIt')}
          onRetry={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
        />
      </div>
    )
  }
}

/** A fresh subtree per retry. */
function ResetKey({ children }: { children: ReactNode }): ReactNode {
  return children
}
