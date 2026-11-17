/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Small pieces the Workspace sections share: a section's head, the pill
// search field and a project's colour dot.
import { forwardRef, type ReactElement, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { IconButton, cx } from '../ui'
import { projectColor } from './logic'

/**
 * A section's head. With a `lead` (the back arrow of a project, a folder, an
 * app or a table) it shows its title; without one the tab above already names
 * the section, so the title is for screen readers only and the head is a light
 * row of the subtitle and the actions.
 */
export function SectionHead({ title, subtitle, actions, lead }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; lead?: ReactNode }): ReactElement {
  return (
    <header className={cx('ws-card__head', !lead && 'ws-card__head--bar')}>
      {lead}
      <div className="ws-card__titles">
        <h2 className="ws-card__title">{title}</h2>
        {subtitle && <p className="ws-card__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ws-card__actions">{actions}</div>}
    </header>
  )
}

export interface SearchBoxProps {
  value: string
  onChange(value: string): void
  placeholder: string
  onEnter?(): void
  autoFocus?: boolean
  className?: string
}

export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox({ value, onChange, placeholder, onEnter, autoFocus, className }, ref) {
  const t = useT()
  return (
    <div className={cx('ws-search', className)}>
      <Search aria-hidden />
      <input
        ref={ref}
        type="text"
        role="searchbox"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.()
          else if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && <IconButton size="sm" label={t('workspace.clearSearch')} icon={<X />} onClick={() => onChange('')} />}
    </div>
  )
})

export function ProjectDot({ color, label }: { color: string | null; label?: string }): ReactElement {
  return <span className={cx('ws-dot', color === null ? 'ws-dot--none' : `ws-dot--${projectColor(color)}`)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}
