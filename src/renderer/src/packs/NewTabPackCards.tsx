/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pack cards on the new tab page (docs/packs.md › Contributions): a pack's
// card module runs in the pack's own sandbox and returns a few lines of text;
// this draws them. No pack code runs here, and nothing shows without a card.
// A card with `open` is a button that runs it (a panel, a skill, a tool).
import { useEffect, useState, type ReactElement } from 'react'
import { Package } from 'lucide-react'
import type { PackCardView } from '@shared/packs'
import { atelier, call } from '../api'
import { useT } from '../i18n/useT'
import { cx, toast } from '../ui'
import './packs.css'

export function NewTabPackCards(): ReactElement | null {
  const t = useT()
  const [cards, setCards] = useState<PackCardView[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void call('packs', 'cards').then(
        (next) => alive && setCards(next),
        () => undefined,
      )
    }
    load()
    const off = atelier.onAppEvent((event) => {
      if (event.type === 'packs') load()
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  if (cards.length === 0) return null
  const open = (card: PackCardView): void => {
    void call('packs', 'openCard', card.packId, card.cardId).catch((err: unknown) => toast.show({ tone: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
  return (
    <section className="pk-ntcards" aria-label={t('packs.cards.label')}>
      {cards.slice(0, 4).map((card) => {
        const body = (
          <>
            <span className="pk-ntcard__head">
              <Package size={13} aria-hidden="true" />
              <span className="pk-ntcard__title">{card.title}</span>
              <span className="pk-ntcard__pack">{card.packName}</span>
            </span>
            {card.error ? (
              <span className="pk-ntcard__line pk-ntcard__line--muted">{t('packs.cards.error')}</span>
            ) : card.lines.length === 0 ? (
              <span className="pk-ntcard__line pk-ntcard__line--muted">{t('packs.cards.empty')}</span>
            ) : (
              card.lines.map((line, i) => (
                <span key={i} className="pk-ntcard__line">
                  {line}
                </span>
              ))
            )}
          </>
        )
        const key = `${card.packId}:${card.cardId}`
        return card.canOpen ? (
          <button key={key} type="button" className={cx('pk-ntcard', 'pk-ntcard--button')} aria-label={`${card.title}, ${t('packs.cards.open')}`} onClick={() => open(card)}>
            {body}
          </button>
        ) : (
          <div key={key} className="pk-ntcard">
            {body}
          </div>
        )
      })}
    </section>
  )
}
