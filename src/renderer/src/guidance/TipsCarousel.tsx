/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A small carousel of tips that fills a wait (ON-06's thinking pauses, the
// import's preparing state): one tip at a time from shared/tips.ts, turning
// about every ten seconds, with previous and next. Reduced motion keeps the
// change instant; screen readers hear each new tip politely.
import { useEffect, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react'
import { tipsFor, type TipContext } from '@shared/tips'
import { IconButton } from '../ui'
import './guidance.css'
import { useT } from '../i18n/useT'

export function TipsCarousel({ context = 'setup-wait', features = {}, label }: { context?: TipContext; features?: Record<string, boolean>; label?: string }): ReactElement | null {
  const t = useT()
  const tips = tipsFor(context, features)
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (tips.length < 2) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % tips.length), 10_000)
    return () => clearInterval(timer)
  }, [tips.length])
  const tip = tips[index % Math.max(1, tips.length)]
  if (!tip) return null
  const step = (d: number): void => setIndex((i) => (i + d + tips.length) % tips.length)
  return (
    <section className="gd-tips" aria-label={label ?? t('core.tipsCarousel.tips')} aria-roledescription="carousel">
      <Lightbulb className="gd-tips__icon" aria-hidden />
      <p className="gd-tips__text" aria-live="polite" key={tip.id}>
        {tip.text}
      </p>
      {tips.length > 1 && (
        <span className="gd-tips__nav">
          <IconButton label={t('core.tipsCarousel.previousTip')} icon={<ChevronLeft />} variant="subtle" size="sm" onClick={() => step(-1)} />
          <span className="gd-tips__count" aria-hidden="true">
            {(index % tips.length) + 1}/{tips.length}
          </span>
          <IconButton label={t('core.tipsCarousel.nextTip')} icon={<ChevronRight />} variant="subtle" size="sm" onClick={() => step(1)} />
        </span>
      )}
    </section>
  )
}
