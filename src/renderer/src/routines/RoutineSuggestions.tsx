/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Suggested routines (DS-102): Apex's own starter set, plus,
// only when proactive.routines is on, ideas from local signals (prompts you
// repeat, sites you open most mornings). Each opens the editor filled in;
// dismissing one keeps it away.
import type { ReactElement } from 'react'
import { CalendarClock, Sparkles, X } from 'lucide-react'
import type { RoutineSuggestion } from '@shared/routines'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, IconButton, useToast } from '../ui'
import { useResource } from '../settings/data'
import { TileGrid } from '../settings/kit'

export interface RoutineSuggestionsProps {
  onPick(suggestion: RoutineSuggestion): void
  /** Bumped when routines change, so a starter you just set up goes away. */
  refreshKey?: unknown
}

const personal = (s: RoutineSuggestion): boolean => s.id.startsWith('prompt-') || s.id.startsWith('site-')

export function RoutineSuggestions({ onPick, refreshKey = null }: RoutineSuggestionsProps): ReactElement | null {
  const t = useT()
  const toast = useToast()
  const list = useResource(() => call('routines', 'suggestions'), refreshKey, { keep: true })
  const items = list.data ?? []
  if (items.length === 0) return null
  const dismiss = (s: RoutineSuggestion): void => {
    list.set(items.filter((x) => x.id !== s.id))
    call('routines', 'dismissSuggestion', s.id).catch((err: unknown) => {
      toast.show({ tone: 'error', message: errorText(err) })
      void list.reload()
    })
  }
  return (
    <section className="rt-suggest" aria-labelledby="rt-suggest-title">
      <h2 id="rt-suggest-title" className="sp-group__label">
        {t('skills.suggest.title')}
      </h2>
      <TileGrid columns={2} label={t('skills.suggest.list')}>
        {items.map((s) => (
          <div key={s.id} role="listitem" className="sp-suggest-card rt-suggest__card">
            <button type="button" className="rt-suggest__main" aria-label={t('skills.suggest.use', { title: s.title })} onClick={() => onPick(s)}>
              <span className="sp-suggest-card__glyph" aria-hidden>
                {personal(s) ? <Sparkles size={16} /> : <CalendarClock size={16} />}
              </span>
              <span className="rt-suggest__text">
                <span className="sp-suggest-card__title">{s.title}</span>
                <span className="sp-suggest-card__desc">{s.reason}</span>
                {personal(s) && <span className="rt-suggest__tag">{t('skills.suggest.personal')}</span>}
              </span>
            </button>
            <IconButton size="sm" className="sp-suggest-card__dismiss" label={t('skills.suggest.dismiss', { title: s.title })} icon={<X />} onClick={() => dismiss(s)} />
          </div>
        ))}
      </TileGrid>
      <div className="sp-guide-pill">
        <Button variant="secondary" onClick={() => void call('pages', 'open', 'apex://guides')}>
          {t('skills.suggest.guides')}
        </Button>
      </div>
    </section>
  )
}
