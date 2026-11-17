/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type ReactElement } from 'react'
import { Ellipsis } from 'lucide-react'
import type { Companion as CompanionRecord } from '@shared/companion'
import type { FirstWeekView } from '@shared/firstWeek'
import { Companion } from '../companion'
import { ShapeField } from '../companion-card/ShapeField'
import { IconButton, menuSeparator, showMenu, type MenuItemSpec } from '../ui'
import { BrandLogo } from '../brand/BrandLogo'
import { useT, t } from '../i18n/useT'

export type HeroAction = 'snooze' | 'unsnooze' | 'dismiss-all' | 'hide' | 'show'

interface HeroProps {
  companion: CompanionRecord | null
  view: FirstWeekView | null
  onAction(action: HeroAction): void
}

const shortDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The page menu: snooze, dismiss all (from day 30) and hide. */
function heroMenu(view: FirstWeekView): MenuItemSpec[] {
  const items: MenuItemSpec[] = []
  if (view.status === 'off') return [{ id: 'show', label: t('firstRun.weekHero.showGettingStartedAgain') }]
  items.push(view.snoozedUntil ? { id: 'unsnooze', label: t('firstRun.weekHero.showThePlanNow') } : { id: 'snooze', label: t('firstRun.weekHero.snoozeUntilTomorrowMorning') })
  const locked = !view.canDismissAll && view.dismissAllAt !== null && view.items.length > 0
  items.push({
    id: 'dismiss-all',
    label: locked && view.dismissAllAt ? t('firstRun.weekHero.dismissAllFrom', { value: shortDate(view.dismissAllAt) }) : t('firstRun.weekHero.dismissAll'),
    enabled: view.canDismissAll,
  })
  items.push(menuSeparator(), { id: 'hide', label: t('firstRun.weekHero.hideGettingStarted') })
  return items
}

/**
 * The banner at the top: Atelier's mark, a heading, a short intro in the
 * companion's voice and the companion itself, live and full-body, standing
 * on the right over the ambient field in its colour.
 */
export function Hero({ companion, view, onAction }: HeroProps): ReactElement {
  const t = useT()
  const menuButton = useRef<HTMLButtonElement>(null)
  const tint = companion?.look.colors.accent ?? null
  const canMenu = view !== null && view.status !== 'not-created'

  const openMenu = async (): Promise<void> => {
    if (!view || !menuButton.current) return
    const picked = await showMenu(heroMenu(view), menuButton.current)
    if (picked) onAction(picked as HeroAction)
  }

  return (
    <header className="fw-hero">
      {tint && <ShapeField tint={tint} density="banner" origin={{ x: 0.86, y: 0.96 }} className="fw-hero__field" />}
      <div className="fw-hero__text">
        <BrandLogo />
        <h1 className="fw-hero__title">{t('firstRun.weekHero.makeYourselfAtHome')}</h1>
        <p className="fw-hero__intro">
          {companion ? t('firstRun.weekHero.imName', { name: companion.name }) : ''}{t('firstRun.weekHero.linedUp')}
        </p>
      </div>
      {companion && (
        <div className="fw-hero__figure">
          <Companion profile={companion} size="fill" framing="full" floor priority={1} title={t('firstRun.weekHero.waitingForYou', { name: companion.name })} />
        </div>
      )}
      {canMenu && (
        <div className="fw-hero__menu">
          <IconButton ref={menuButton} label={t('firstRun.weekHero.gettingStartedOptions')} icon={<Ellipsis />} size="sm" onClick={() => void openMenu()} />
        </div>
      )}
    </header>
  )
}
