/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { AlarmClock, CircleCheck, EyeOff, Info, Sparkles } from 'lucide-react'
import { HIDE_REASON_LABELS, guideById, type FirstWeekItem, type FirstWeekView } from '@shared/firstWeek'
import { call, errorText } from '../api'
import { cheerCompanion } from '../companion'
import { useActiveCompanion } from '../components/companionData'
import { dismissItem, runItem } from '../first-week/actions'
import { GuidePage } from '../first-week/GuidePage'
import { Hero, type HeroAction } from '../first-week/Hero'
import { HideDialog } from '../first-week/HideDialog'
import { PlanGrid } from '../first-week/PlanGrid'
import { Tutorials } from '../first-week/Tutorials'
import { useFirstWeek } from '../first-week/useFirstWeek'
import { Button, ErrorState, Skeleton, confirm, toast } from '../ui'
import '../first-week/first-week.css'
import { useT } from '../i18n/useT'

interface FirstWeekPageProps {
  tabId: string
  /** A guide id (apex://first-week/<guide>); anything else shows the plan. */
  section: string | null
}

const morning = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/** A quiet panel where the grid would be. */
function Rest({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }): ReactElement {
  return (
    <section className="fw-plan" aria-live="polite">
      <div className="fw-rest">
        <span className="fw-rest__icon" aria-hidden>
          {icon}
        </span>
        <div className="fw-rest__text">
          <p className="fw-rest__title">{title}</p>
          <p className="fw-rest__desc">{description}</p>
        </div>
        {action}
      </div>
    </section>
  )
}

/**
 * apex://first-week: the getting-started page. A hero in the companion's
 * colour, the plan of things to try, and short guides. It opens once by
 * itself after setup and is reachable any time at this address.
 */
export function FirstWeekPage({ tabId, section }: FirstWeekPageProps): ReactElement {
  const t = useT()
  const companion = useActiveCompanion()
  const [view, setView, error] = useFirstWeek()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [hiding, setHiding] = useState(false)
  const guide = guideById(section)
  const tint = companion?.look.colors.accent

  // Finishing the last card earns a small celebration from the companion.
  const lastDone = useRef<number | null>(null)
  useEffect(() => {
    if (!view || view.total === 0) return
    if (lastDone.current !== null && view.done > lastDone.current && view.done === view.total && companion) cheerCompanion(companion.id)
    lastDone.current = view.done
  }, [view?.done, view?.total])

  const apply = async (task: Promise<FirstWeekView>): Promise<FirstWeekView | null> => {
    try {
      const next = await task
      setView(next)
      return next
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      return null
    }
  }

  const run = (item: FirstWeekItem): void => {
    if (busyId) return
    setBusyId(item.id)
    void runItem(item, companion?.id ?? null, setView).finally(() => setBusyId(null))
  }

  const onHeroAction = async (action: HeroAction): Promise<void> => {
    switch (action) {
      case 'snooze': {
        const next = await apply(call('firstWeek', 'snooze'))
        if (next?.snoozedUntil) toast.show({ message: t('firstRun.firstWeekPage.snoozedUntilTomorrow', { value: morning(next.snoozedUntil) }), undo: () => void apply(call('firstWeek', 'unsnooze')) })
        return
      }
      case 'unsnooze':
        await apply(call('firstWeek', 'unsnooze'))
        return
      case 'dismiss-all': {
        const ok = await confirm({ title: t('firstRun.firstWeekPage.dismissEveryCard'), message: t('firstRun.firstWeekPage.thePlanWillBe'), confirmLabel: t('firstRun.firstWeekPage.dismissAll') })
        if (ok) await apply(call('firstWeek', 'dismissAll'))
        return
      }
      case 'hide':
        setHiding(true)
        return
      case 'show':
        await apply(call('firstWeek', 'show'))
        return
    }
  }

  const plan = (): ReactElement => {
    if (error && !view) {
      return (
        <section className="fw-plan">
          <ErrorState compact title={t('firstRun.firstWeekPage.couldnTLoadYour')} message={error.message} onRetry={() => apply(call('firstWeek', 'view'))} />
        </section>
      )
    }
    if (!view) {
      return (
        <section className="fw-plan" aria-busy="true" aria-label={t('firstRun.firstWeekPage.loadingYourPlan')}>
          <ul className="fw-plan__grid">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i}>
                <Skeleton height={76} radius={16} />
              </li>
            ))}
          </ul>
        </section>
      )
    }
    if (view.status === 'not-created') {
      return (
        <Rest
          icon={<Sparkles size={18} />}
          title={t('firstRun.firstWeekPage.yourPlanAppearsOnce')}
          description={t('firstRun.firstWeekPage.finishSettingUpApex')}
          action={<Button variant="secondary" onClick={() => void call('pages', 'open', 'apex://welcome')}>{t('firstRun.firstWeekPage.finishSetup')}</Button>}
        />
      )
    }
    if (view.status === 'off') {
      return (
        <Rest
          icon={<EyeOff size={18} />}
          title={t('firstRun.firstWeekPage.gettingStartedIsHidden')}
          description={view.hiddenReason ? `You hid it: ${HIDE_REASON_LABELS[view.hiddenReason].toLowerCase()}.` : t('firstRun.firstWeekPage.youCanBringIt')}
          action={<Button variant="secondary" onClick={() => void apply(call('firstWeek', 'show'))}>{t('firstRun.firstWeekPage.showItAgain')}</Button>}
        />
      )
    }
    if (view.snoozedUntil) {
      return (
        <Rest
          icon={<AlarmClock size={18} />}
          title={t('firstRun.firstWeekPage.snoozedUntilTomorrow', { value: morning(view.snoozedUntil) })}
          description={t('firstRun.firstWeekPage.yourPlanIsWaiting')}
          action={<Button variant="secondary" onClick={() => void apply(call('firstWeek', 'unsnooze'))}>{t('firstRun.firstWeekPage.showNow')}</Button>}
        />
      )
    }
    if (view.items.length === 0) {
      return <Rest icon={<CircleCheck size={18} />} title={t('firstRun.firstWeekPage.nothingLeftToTry')} description={t('firstRun.firstWeekPage.youVePutEverything')} />
    }
    return (
      <PlanGrid
        items={view.items}
        done={view.done}
        total={view.total}
        busyId={busyId}
        onRun={run}
        onDismiss={(item) => void dismissItem(item, setView)}
        onSetDone={(item, done) => void apply(call('firstWeek', 'setDone', item.id, done))}
      />
    )
  }

  return (
    <div className="page fw" style={tint ? ({ '--fw-tint': tint } as CSSProperties) : undefined}>
      <div className="fw__scroll" key={guide?.id ?? 'plan'}>
        {guide ? (
          <GuidePage id={guide.id} tabId={tabId} />
        ) : (
          <div className="fw__column">
            {view?.notice && (
              <div className="fw-notice" role="status">
                <Info size={16} aria-hidden />
                <p>{view.notice}</p>
                <Button size="sm" variant="ghost" onClick={() => void apply(call('firstWeek', 'acknowledge'))}>
                  {t('firstRun.firstWeekPage.ok')}
                </Button>
              </div>
            )}
            <Hero companion={companion} view={view} onAction={(a) => void onHeroAction(a)} />
            {plan()}
            <Tutorials />
          </div>
        )}
      </div>
      <HideDialog
        open={hiding}
        onClose={() => setHiding(false)}
        onHide={(reason, note) => {
          setHiding(false)
          void apply(call('firstWeek', 'hide', reason, note || undefined))
        }}
      />
    </div>
  )
}
