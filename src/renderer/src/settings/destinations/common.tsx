/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared frame for the destination pages (Skills, Routines, Connectors and
// the History, Bookmarks and Downloads lists): one scrolling column with a
// header, a toolbar and a list that is loading, failed, empty or filled.
import { useLayoutEffect, type ReactElement, type ReactNode, type RefObject } from 'react'
import { SearchX } from 'lucide-react'
import type { Companion } from '@shared/services'
import { EmptyState, ErrorState, Select, SkeletonRows } from '../../ui'
import { ListFrame } from '../kit'
import { ownerFilterOptions, type OwnerCompanion } from '../logic/filters'
import '../settings.css'
import { useT } from '../../i18n/useT'

/**
 * `centred` is the DS-100 column (min(838, sheet − 64)); `fluid` is the
 * wide, left-aligned template with 32 px gutters (DS-105, Library).
 */
export function DestinationFrame({ children, label, variant = 'centred' }: { children: ReactNode; label: string; variant?: 'centred' | 'fluid' }): ReactElement {
  return (
    <div className="sp-page">
      <main className={variant === 'fluid' ? 'sp-main sp-main--fluid' : 'sp-main'} aria-label={label}>
        <div className={variant === 'fluid' ? 'sp-content sp-content--wide sp-content--fluid' : 'sp-content sp-content--wide'}>{children}</div>
      </main>
    </div>
  )
}

export interface ListStateProps {
  /** null while loading. */
  items: readonly unknown[] | null
  /** How many are left after search and filters. */
  shown: number
  error: string | null
  onRetry(): Promise<void>
  loadingLabel: string
  empty: ReactNode
  /** Clears search and filters from the no-results state. */
  onClearFilters?(): void
  children: ReactNode
  avatar?: boolean
}

/** The list body: skeleton, error with retry, empty state, no-results, or the rows. */
export function ListState({ items, shown, error, onRetry, loadingLabel, empty, onClearFilters, children, avatar }: ListStateProps): ReactElement {
  const t = useT()
  if (items === null) {
    return <ListFrame>{error ? <ErrorState message={error} onRetry={onRetry} /> : <SkeletonRows rows={4} avatar={avatar} label={loadingLabel} />}</ListFrame>
  }
  if (items.length === 0) return <ListFrame>{empty}</ListFrame>
  if (shown === 0) {
    return (
      <ListFrame>
        <EmptyState
          icon={<SearchX />}
          title={t('settings.common.nothingMatches')}
          description={t('settings.common.tryOtherWordsOr')}
          action={onClearFilters && <button type="button" className="sp-link" onClick={onClearFilters}>{t('settings.common.clearSearchAndFilters')}</button>}
        />
      </ListFrame>
    )
  }
  return <>{children}</>
}

export function OwnerFilterSelect({ value, onChange, companions }: { value: string; onChange(value: string): void; companions: readonly OwnerCompanion[] }): ReactElement {
  const t = useT()
  return <Select aria-label={t('settings.common.companion')} value={value} options={ownerFilterOptions(companions)} onChange={onChange} />
}

/** Companions as the owner helpers need them; an empty list while loading. */
export function ownerList(items: Companion[] | null): OwnerCompanion[] {
  return (items ?? []).map((c) => ({ id: c.id, name: c.name, hidden: c.hidden }))
}

/**
 * Lets an editor inside a dialog decide what Esc, the scrim and the close
 * button do (ask before dropping unsaved edits). The dialog calls
 * `guard.current` when set, otherwise its plain close.
 */
export function useCloseGuard(guard: RefObject<(() => void) | null>, check: () => void): void {
  useLayoutEffect(() => {
    guard.current = check
    return () => {
      guard.current = null
    }
  })
}

/**
 * A destination's centred empty state (DS-100): a 30 px line glyph, a medium
 * caption, then an ink pill and an outlined pill.
 */
export function DestinationEmpty({ icon, title, description, primary, secondary }: { icon: ReactNode; title: ReactNode; description?: ReactNode; primary?: ReactNode; secondary?: ReactNode }): ReactElement {
  return (
    <div className="sp-dest-empty" role="status">
      {icon}
      <p className="sp-dest-empty__title">{title}</p>
      {description && <p className="sp-dest-empty__description">{description}</p>}
      {(primary || secondary) && (
        <div className="sp-dest-empty__actions">
          {primary}
          {secondary}
        </div>
      )}
    </div>
  )
}
