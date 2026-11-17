/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { AppWindow, Database, MessageSquare, Plug, UserRound } from 'lucide-react'
import { t } from '@shared/i18n/core'
import type { ConnectorRecordHit } from '@shared/connectors'
import type { Companion } from '@shared/services'
import { cx } from '../../ui'
import { CompanionAvatar } from '../CompanionAvatar'
import { MENTION_FILTERS, type MentionCandidate, type MentionFilter, type MentionKind } from '../logic/mentions'
import { Favicon } from './icons'

// The @ list (CH-25) and the # record list (CH-08), drawn just above the
// composer while the field keeps focus: the field owns the keys (↑ ↓, Enter,
// Tab, Esc) and these only draw, so a press here never takes focus away.

const FILTER_LABEL: Record<MentionFilter, () => string> = {
  all: () => t('composer.mention.all'),
  tab: () => t('composer.mention.tabs'),
  chat: () => t('composer.mention.chats'),
  companion: () => t('composer.mention.companions'),
  connector: () => t('composer.mention.connectors'),
}

const KIND_LABEL: Record<MentionKind, () => string> = {
  tab: () => t('composer.mention.kind.tab'),
  chat: () => t('composer.mention.kind.chat'),
  companion: () => t('composer.mention.kind.companion'),
  connector: () => t('composer.mention.kind.connector'),
}

const EMPTY: Record<MentionFilter, () => string> = {
  all: () => t('composer.mention.empty.all'),
  tab: () => t('composer.mention.empty.tab'),
  chat: () => t('composer.mention.empty.chat'),
  companion: () => t('composer.mention.empty.companion'),
  connector: () => t('composer.mention.empty.connector'),
}

export interface MentionListProps {
  id: string
  items: readonly MentionCandidate[]
  /** Whether anything exists under this filter at all (empty vs no match). */
  any: boolean
  filter: MentionFilter
  query: string
  active: number
  companions: readonly Companion[]
  onFilter(filter: MentionFilter): void
  onActive(index: number): void
  onPick(index: number): void
}

export const optionId = (listId: string, index: number): string => `${listId}-opt-${index}`

function Lead({ item, companions }: { item: MentionCandidate; companions: readonly Companion[] }): ReactElement {
  switch (item.kind) {
    case 'tab':
      return item.icon ? <Favicon src={item.icon} /> : <AppWindow aria-hidden="true" />
    case 'chat':
      return <MessageSquare aria-hidden="true" />
    case 'companion': {
      const companion = companions.find((c) => c.id === item.id)
      return companion ? <CompanionAvatar companion={companion} size={20} label="" /> : <UserRound aria-hidden="true" />
    }
    case 'connector':
      return <Plug aria-hidden="true" />
  }
}

export function MentionList({ id, items, any, filter, query, active, companions, onFilter, onActive, onPick }: MentionListProps): ReactElement {
  return (
    <div className="cmp-list" role="dialog" aria-label={t('composer.mention.label')}>
      <div className="cmp-list__filters" role="group" aria-label={t('composer.mention.filters')}>
        {MENTION_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={cx('cmp-list__filter', f === filter && 'cmp-list__filter--on')}
            aria-pressed={f === filter}
            tabIndex={-1}
            onMouseDown={(e) => {
              // The field keeps focus (and the caret) while you click a filter.
              e.preventDefault()
              onFilter(f)
            }}
          >
            {FILTER_LABEL[f]()}
          </button>
        ))}
      </div>
      <ul className="cmp-list__options" role="listbox" id={id} aria-label={FILTER_LABEL[filter]()}>
        {items.map((item, index) => (
          <li
            key={`${item.kind}:${item.id}`}
            id={optionId(id, index)}
            role="option"
            aria-selected={index === active}
            className={cx('cmp-list__option', index === active && 'cmp-list__option--active')}
            onMouseEnter={() => onActive(index)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(index)
            }}
          >
            <span className="cmp-list__lead" aria-hidden="true">
              <Lead item={item} companions={companions} />
            </span>
            <span className="cmp-list__text">
              <span className="cmp-list__label">{item.label}</span>
              {item.detail && <span className="cmp-list__detail">{item.detail}</span>}
            </span>
            {filter === 'all' && <span className="cmp-list__kind">{KIND_LABEL[item.kind]()}</span>}
          </li>
        ))}
      </ul>
      {items.length === 0 && (
        <p className="cmp-list__empty" role="status">
          {any && query.trim() ? t('composer.mention.noMatch', { query: query.trim() }) : EMPTY[filter]()}
        </p>
      )}
      <p className="cmp-list__hint" aria-hidden="true">{t('composer.mention.hint')}</p>
    </div>
  )
}

export interface RecordListProps {
  id: string
  hits: readonly ConnectorRecordHit[]
  connectorName(id: string): string
  active: number
  onActive(index: number): void
  onPick(index: number): void
}

/** The # list shows only while something matches; nothing to show means no list at all. */
export function RecordList({ id, hits, connectorName, active, onActive, onPick }: RecordListProps): ReactElement {
  return (
    <div className="cmp-list" role="dialog" aria-label={t('composer.records.label')}>
      <ul className="cmp-list__options" role="listbox" id={id} aria-label={t('composer.records.label')}>
        {hits.map((hit, index) => (
          <li
            key={`${hit.connectorId}:${hit.uri}`}
            id={optionId(id, index)}
            role="option"
            aria-selected={index === active}
            className={cx('cmp-list__option', 'cmp-list__option--tall', index === active && 'cmp-list__option--active')}
            onMouseEnter={() => onActive(index)}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(index)
            }}
          >
            <span className="cmp-list__lead" aria-hidden="true">
              <Database />
            </span>
            <span className="cmp-list__text">
              <span className="cmp-list__label">{hit.title}</span>
              {hit.snippet && <span className="cmp-list__detail">{hit.snippet}</span>}
            </span>
            <span className="cmp-list__kind">{connectorName(hit.connectorId)}</span>
          </li>
        ))}
      </ul>
      <p className="cmp-list__hint" aria-hidden="true">{t('composer.records.hint')}</p>
    </div>
  )
}
