/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement, type ReactNode } from 'react'
import { cx } from './logic/format'
import { rovingIndex } from './logic/keys'

export interface TabItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  /** Drawn after the label, e.g. a count Badge. */
  badge?: ReactNode
  disabled?: boolean
  title?: string
}

export interface TabListProps {
  tabs: readonly TabItem[]
  value: string
  onChange(id: string): void
  /** Accessible name for the list, e.g. "Companion sections". */
  label: string
  /** Ties tabs to their <TabPanel>s; unique per page. */
  idPrefix: string
  orientation?: 'horizontal' | 'vertical'
  /** 'auto' selects as focus moves; 'manual' waits for Enter or Space. */
  activation?: 'auto' | 'manual'
  /** 'line' underlines the choice; 'pill' fills it; 'nav' is a vertical page nav. */
  variant?: 'line' | 'pill' | 'nav'
  className?: string
}

export function tabDomId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`
}

export function panelDomId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`
}

/** Tabs with roving focus: arrows move along the list, Home and End jump to the ends. */
export function TabList({ tabs, value, onChange, label, idPrefix, orientation = 'horizontal', activation = 'auto', variant = 'line', className }: TabListProps): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = tabs.findIndex((t) => t.id === value)
  const focusable = selected >= 0 ? selected : tabs.findIndex((t) => !t.disabled)
  return (
    <div role="tablist" aria-label={label} aria-orientation={orientation} className={cx('ui-tabs', `ui-tabs--${variant}`, `ui-tabs--${orientation}`, className)}>
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          ref={(el) => {
            refs.current[i] = el
          }}
          id={tabDomId(idPrefix, tab.id)}
          type="button"
          role="tab"
          aria-selected={i === selected}
          aria-controls={panelDomId(idPrefix, tab.id)}
          tabIndex={i === focusable ? 0 : -1}
          disabled={tab.disabled}
          title={tab.title}
          className="ui-tabs__tab"
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => {
            const next = rovingIndex(e.key, i, tabs.length, { orientation, disabled: (j) => !!tabs[j]?.disabled })
            if (next === null) return
            e.preventDefault()
            refs.current[next]?.focus()
            const target = tabs[next]
            if (activation === 'auto' && target) onChange(target.id)
          }}
        >
          {tab.icon}
          <span className="ui-tabs__label">{tab.label}</span>
          {tab.badge}
        </button>
      ))}
    </div>
  )
}

export interface TabPanelProps {
  idPrefix: string
  tabId: string
  children: ReactNode
  className?: string
}

export function TabPanel({ idPrefix, tabId, children, className }: TabPanelProps): ReactElement {
  return (
    <div role="tabpanel" id={panelDomId(idPrefix, tabId)} aria-labelledby={tabDomId(idPrefix, tabId)} tabIndex={0} className={cx('ui-tab-panel', className)}>
      {children}
    </div>
  )
}
