/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import type { RecentTabsProps } from '@shared/overlay/tabs'
import { MessageSquare } from 'lucide-react'
import { call } from '../../../api'
import { useT } from '../../../i18n/useT'
import { cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { PageFavicon, PageThumb } from './cardParts'

// The recent-tab switcher (SH-29): up to eight cards in most-recently-used
// order, in up to four columns; a split pair is one card and chats show
// their icon. The chrome drives the selection from ⌃Tab; releasing Control
// or Enter commits, Esc or a click outside cancels. Hovering selects a card
// only after the pointer has really moved, so a still pointer under the
// grid doesn't steal the selection; the chrome hears the pick through main.

/** Columns for n cards: one row up to four, then rows of four. */
export function switcherColumns(count: number): number {
  return Math.max(1, Math.min(4, count))
}

export function RecentTabs({ props, resolve, close }: SurfaceComponentProps<RecentTabsProps>): ReactElement {
  const t = useT()
  const origin = useRef<{ x: number; y: number } | null>(null)
  const moved = useRef(false)
  const cards = props.cards.slice(0, 8)
  const selected = Math.min(Math.max(0, props.selected), cards.length - 1)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const card = cards[selected]
        if (card) resolve({ commit: card.tabId })
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const cols = switcherColumns(cards.length)
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : -cols
        void call('tabs', 'switcherHover', (selected + step + cards.length) % cards.length)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cards, selected, resolve, close])

  return (
    <div
      className="recent-tabs"
      role="listbox"
      aria-label={t('tabs.recent.label')}
      aria-activedescendant={cards[selected] ? `recent-card-${selected}` : undefined}
      style={{ ['--recent-cols' as string]: switcherColumns(cards.length) }}
      onPointerMove={(e) => {
        if (!origin.current) origin.current = { x: e.clientX, y: e.clientY }
        else if (Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 6) moved.current = true
      }}
    >
      {cards.map((card, i) => {
        const lead = card.pages[0]
        if (!lead) return null
        return (
          <div
            key={card.tabId}
            id={`recent-card-${i}`}
            role="option"
            aria-selected={i === selected}
            className={cx('recent-card', i === selected && 'recent-card--selected', card.kind === 'split' && 'recent-card--split')}
            onPointerEnter={() => {
              // The chrome owns the selection (Control's release commits it), so the pick goes through main.
              if (moved.current && i !== selected) void call('tabs', 'switcherHover', i)
            }}
            onClick={() => resolve({ commit: card.tabId })}
          >
            <div className="recent-card__thumbs">
              {card.kind === 'chat' ? (
                <div className="recent-card__chat" aria-hidden>
                  <MessageSquare size={22} />
                </div>
              ) : (
                card.pages.map((page) => <PageThumb key={page.tabId} page={page} />)
              )}
            </div>
            <div className="recent-card__title">
              {card.kind === 'chat' ? <MessageSquare size={12} aria-hidden /> : <PageFavicon src={lead.favicon} size={12} />}
              <span>{card.kind === 'split' ? card.pages.map((p) => p.title).join(' · ') : lead.title}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
