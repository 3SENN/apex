/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { TabInfo } from '@shared/ipc'
import type { TabGroupPatch } from '@shared/services/tabs'
import type { TabGroup } from '@shared/tabs'
import { GROUP_NAME_MAX } from '@shared/tabs'
import { ChevronRight } from 'lucide-react'
import { apex, call, errorText } from '../../api'
import { t } from '../../i18n/useT'
import { cx, toast } from '../../ui'
import { groupCard } from './cardContent'
import { closeCard, hoverRow, leaveRow } from './hoverCard'
import { groupMembers } from './logic/groups'
import { openGroupMenu } from './tabActions'

// A tab group's header row (SH-23, SH-24): the colour chip and name,
// with the tab count while collapsed. Click, Enter or Space collapses or
// expands it; a new group starts renaming (Enter commits, Esc cancels).
// Hovering a collapsed group shows a card of its tabs. Groups have no icons.

interface GroupRowProps {
  group: TabGroup
  tabIds: readonly string[]
  tabs: readonly TabInfo[]
  renaming: boolean
  focusable: boolean
  onRename(renaming: boolean): void
  /** 'chip' is the horizontal strip's group chip (SH-21): its card opens below it. */
  variant?: 'row' | 'chip'
}

export function groupLabel(group: TabGroup): string {
  return group.name || t(`tabs.groupColor.${group.color}`)
}

export function GroupRow({ group, tabIds, tabs, renaming, focusable, onRename, variant = 'row' }: GroupRowProps): ReactElement {
  const chip = variant === 'chip'
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(group.name)
  const key = `group:${group.id}`
  const count = tabIds.length

  useEffect(() => {
    if (!renaming) return
    setDraft(group.name)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
  }, [renaming, group.name])

  const update = (patch: TabGroupPatch): void =>
    void call('tabGroups', 'update', group.id, patch).catch((err: unknown) => toast.show({ message: `${t('tabs.error.group')} ${errorText(err)}`, tone: 'error' }))
  const toggle = (): void => {
    closeCard()
    update({ collapsed: !group.collapsed })
  }
  const commit = (): void => {
    onRename(false)
    const name = draft.trim().slice(0, GROUP_NAME_MAX)
    if (name !== group.name) update({ name })
  }

  return (
    <div
      role={chip ? 'button' : 'option'}
      aria-selected={chip ? undefined : false}
      aria-expanded={!group.collapsed}
      aria-label={`${groupLabel(group)}, ${group.collapsed ? t('tabs.group.collapsedHint', { count }) : t('tabs.group.expandedHint')}`}
      tabIndex={focusable ? 0 : -1}
      data-sidebar-row={chip ? undefined : ''}
      data-group-row={group.id}
      data-group-color={group.color}
      data-flip={key}
      className={cx(chip ? 'strip-group' : 'side-row group-row', group.collapsed && 'group-row--collapsed', renaming && 'group-row--renaming')}
      onClick={(e) => {
        if (renaming || (e.target instanceof Element && e.target.closest('input'))) return
        toggle()
      }}
      onDoubleClick={(e) => {
        e.preventDefault()
        onRename(true)
      }}
      onKeyDown={(e) => {
        if (renaming || e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          toggle()
        } else if (e.key === 'F2') {
          e.preventDefault()
          onRename(true)
        }
      }}
      onContextMenu={(e) => void openGroupMenu(e, group, count, () => onRename(true))}
      onPointerEnter={(e) => {
        if (!group.collapsed || renaming) return
        hoverRow(e.currentTarget, {
          key,
          side: chip ? 'below' : 'right',
          build: async () => groupCard(group, groupMembers(tabs, tabIds)),
          onChoose: (value) => {
            if (typeof value === 'string') void apex.tabs.activate(value)
          },
        })
      }}
      onPointerLeave={() => leaveRow(key)}
      onPointerDown={() => closeCard()}
    >
      <span className="group-row__chevron" aria-hidden>
        <ChevronRight size={12} />
      </span>
      {renaming ? (
        <input
          ref={input}
          className="group-row__input"
          value={draft}
          maxLength={GROUP_NAME_MAX}
          aria-label={t('tabs.group.nameLabel')}
          placeholder={t(`tabs.groupColor.${group.color}`)}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onRename(false)
              setDraft(group.name)
            }
          }}
        />
      ) : (
        <span className="group-row__chip">{groupLabel(group)}</span>
      )}
      {group.collapsed && !renaming && <span className="group-row__count">{t('tabs.group.count', { count })}</span>}
    </div>
  )
}
