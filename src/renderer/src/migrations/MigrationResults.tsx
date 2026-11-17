/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { CircleCheck, MessageSquareWarning } from 'lucide-react'
import { currentLocale } from '@shared/i18n/core'
import type { MigrationOutcome, MigrationReport } from '@shared/migrations'
import { chatUrl } from '@shared/url'
import { call, errorText, useAppEvent } from '../api'
import { useT, type T } from '../i18n/useT'
import { Card, Row, Section } from '../settings/kit'
import { Button, ErrorState, SkeletonText, toast } from '../ui'
import './migrations.css'

// About › Data updates (part of ST-56, SS-09): "142 chats updated on
// 28 Oct", or "All your chats are up to date". Chats that couldn't be
// updated are listed with Open and Retry all; chats and files a newer Apex
// saved are listed too, so a downgrade is never silent.

const CHAT_ID = /^[0-9a-f-]{36}$/

/** The headline: the last run's count and day, or the up-to-date line. */
export function resultsHeadline(report: MigrationReport, t: T, locale = currentLocale()): string {
  if (report.migrated > 0 && report.lastRunAt !== null) {
    const date = new Date(report.lastRunAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
    return t('migrations.about.summary', { count: report.migrated, date })
  }
  if (report.failed.length > 0) return t('migrations.about.failedTitle', { count: report.failed.length })
  return t('migrations.about.upToDate')
}

/** A friendly name for a versioned file (settings.json), or the chat's title. */
function outcomeName(outcome: MigrationOutcome, t: T): string {
  if (outcome.id === 'settings.json') return t('migrations.file.settings')
  if (outcome.id === 'companions.json') return t('migrations.file.companions')
  return outcome.title.trim() || t('migrations.about.untitled')
}

export function MigrationResults(): ReactElement {
  const t = useT()
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const load = async (): Promise<void> => {
    setError(null)
    try {
      setReport(await call('migrations', 'report'))
    } catch (err) {
      setError(errorText(err))
    }
  }
  useEffect(() => {
    void load()
  }, [])
  useAppEvent('migrations', (event) => setReport(event.report))

  const retryAll = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    try {
      const next = await call('migrations', 'retryAll')
      setReport(next)
      toast.show({ message: t('migrations.about.retryAllDone', { count: next.failed.length }), tone: next.failed.length === 0 ? 'success' : 'info' })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setRetrying(false)
    }
  }

  const open = (id: string): void => {
    void call('pages', 'open', chatUrl(id)).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }

  let body: ReactElement
  if (error) {
    body = <ErrorState compact title={t('migrations.about.loadError')} message={error} onRetry={load} />
  } else if (!report) {
    body = (
      <div className="migration-results__loading" aria-busy="true">
        <SkeletonText lines={2} />
      </div>
    )
  } else {
    const healthy = report.failed.length === 0 && report.newer.length === 0
    const headline = resultsHeadline(report, t)
    body = (
      <>
        <Row
          title={
            <span className="migration-results__headline">
              {healthy ? <CircleCheck size={16} aria-hidden="true" className="migration-results__ok" /> : <MessageSquareWarning size={16} aria-hidden="true" className="migration-results__warn" />}
              {headline}
            </span>
          }
          description={healthy && report.migrated > 0 ? t('migrations.about.upToDate') : t('migrations.about.description')}
        />
        {report.failed.length > 0 && (
          <OutcomeList
            title={t('migrations.about.failedTitle', { count: report.failed.length })}
            items={report.failed}
            describe={(o) => o.error ?? ''}
            t={t}
            onOpen={open}
          />
        )}
        {report.newer.length > 0 && (
          <OutcomeList
            title={t('migrations.about.newerTitle')}
            items={report.newer}
            describe={(o) => t(CHAT_ID.test(o.id) ? 'migrations.about.newerChat' : 'migrations.about.newerFile')}
            t={t}
            onOpen={open}
          />
        )}
      </>
    )
  }

  return (
    <Section
      title={t('migrations.about.title')}
      actions={
        report && report.failed.length > 0 ? (
          <Button size="sm" loading={retrying} onClick={() => void retryAll()}>
            {t('migrations.about.retryAll')}
          </Button>
        ) : undefined
      }
    >
      <Card className="migration-results">{body}</Card>
    </Section>
  )
}

function OutcomeList({ title, items, describe, t, onOpen }: { title: string; items: MigrationOutcome[]; describe(o: MigrationOutcome): string; t: T; onOpen(id: string): void }): ReactElement {
  return (
    <div className="migration-results__group">
      <p className="migration-results__group-title">{title}</p>
      <ul className="migration-results__list">
        {items.map((outcome) => (
          <li key={outcome.id} className="migration-results__item">
            <div className="migration-results__text">
              <span className="migration-results__name">{outcomeName(outcome, t)}</span>
              {describe(outcome) && <span className="migration-results__detail">{describe(outcome)}</span>}
            </div>
            {CHAT_ID.test(outcome.id) && (
              <Button size="sm" variant="ghost" onClick={() => onOpen(outcome.id)} aria-label={`${t('migrations.action.open')}: ${outcomeName(outcome, t)}`}>
                {t('migrations.action.open')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
