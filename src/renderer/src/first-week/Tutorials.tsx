/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Play } from 'lucide-react'
import { FIRST_WEEK_GUIDES, firstWeekGuideSummary, firstWeekGuideTitle, guideUrl, type FirstWeekGuide } from '@shared/firstWeek'
import { call, errorText } from '../api'
import { toast } from '../ui'
import { GuideScene } from './scenes'
import { useT } from '../i18n/useT'

/** Guides open in their own tab, so the plan stays where it was. */
export function openGuide(id: string): void {
  call('pages', 'open', guideUrl(id), { newTab: true }).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
}

/** `onOpen` replaces the default of opening the guide in a new tab. */
export function GuideCard({ guide, onOpen }: { guide: FirstWeekGuide; onOpen?: () => void }): ReactElement {
  const t = useT()
  return (
    <button type="button" className="fw-tut" onClick={onOpen ?? (() => openGuide(guide.id))} aria-label={t('firstRun.weekTutorials.minuteGuide', { title: firstWeekGuideTitle(guide.id) ?? guide.title, minutes: guide.minutes })}>
      <span className="fw-tut__preview">
        <GuideScene id={guide.id} />
        <span className="fw-tut__play" aria-hidden>
          <Play size={20} fill="currentColor" />
        </span>
        <span className="fw-tut__badge" aria-hidden>
          {t('firstRun.weekTutorials.min', { minutes: guide.minutes })}
        </span>
      </span>
      <span>
        <span className="fw-tut__title">{firstWeekGuideTitle(guide.id) ?? guide.title}</span>
        <span className="fw-tut__desc">{firstWeekGuideSummary(guide.id) ?? guide.summary}</span>
      </span>
    </button>
  )
}

/** Short animated guides; each preview loops while hovered. */
export function Tutorials(): ReactElement {
  const t = useT()
  return (
    <section className="fw-section" aria-labelledby="fw-guides-title">
      <h2 id="fw-guides-title" className="fw-section__title">
        {t('firstRun.weekTutorials.shortGuides')}
      </h2>
      <p className="fw-section__subtitle">
        {t('firstRun.weekTutorials.aFewMinutesEach')}{' '}
        {/* ON-16: the rest of Apex's guides and bundles */}
        <button type="button" className="sp-link" onClick={() => call('pages', 'open', 'apex://guides', { newTab: true }).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))}>
          {t('firstRun.weekTutorials.allGuides')}
        </button>
      </p>
      <ul className="fw-tutorials">
        {FIRST_WEEK_GUIDES.map((guide) => (
          <li key={guide.id}>
            <GuideCard guide={guide} />
          </li>
        ))}
      </ul>
    </section>
  )
}
