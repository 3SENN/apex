/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Model and key › Usage: tokens your companions
// used this month and over the last 30 days, by day as bars, and by chat,
// companion, model and kind of work. Costs appear only as an estimate, for
// turns on your API key; other engines' turns show tokens only. Atelier sells
// nothing: no credits, plans, quotas or upgrade prompts.
import { useState, type ReactElement } from 'react'
import { BarChart3, Table2 } from 'lucide-react'
import { formatEstimate, formatTokens, usageBars, usageRanges, usageTokens, type UsageGroupBy, type UsageReport, type UsageTotals } from '@shared/usage'
import { call } from '../../api'
import { useT, type T } from '../../i18n/useT'
import { Button, EmptyState, ErrorState, SkeletonRows } from '../../ui'
import { useEvent, useResource } from '../data'
import { Card, Section } from '../kit'

interface UsageData {
  month: UsageReport
  days: UsageReport
  chats: UsageReport
  companions: UsageReport
  models: UsageReport
  kinds: UsageReport
}

async function loadUsage(now: number): Promise<UsageData> {
  const { month, last30 } = usageRanges(now)
  const report = (range: { from: number; to: number }, by: UsageGroupBy): Promise<UsageReport> => call('usage', 'report', range, by)
  const [m, days, chats, companions, models, kinds] = await Promise.all([
    report(month, 'kind'),
    report(last30, 'day'),
    report(last30, 'chat'),
    report(last30, 'companion'),
    report(last30, 'model'),
    report(last30, 'kind'),
  ])
  return { month: m, days, chats, companions, models, kinds }
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function totalsLine(t: T, totals: UsageTotals): string {
  const parts = [t('agent.usage.tokens', { count: formatTokens(usageTokens(totals)) }), t('agent.usage.turns', { n: totals.turns })]
  const cost = formatEstimate(totals.approxCostUsd)
  if (cost) parts.push(`${t('agent.usage.approx', { cost })} (${t('agent.usage.estimate').toLowerCase()})`)
  return parts.join(' · ')
}

function DayBars({ report }: { report: UsageReport }): ReactElement {
  const t = useT()
  const [table, setTable] = useState(false)
  const heights = usageBars(report.rows)
  const toggle = (
    <Button size="sm" variant="ghost" icon={table ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />} onClick={() => setTable((v) => !v)} aria-pressed={table}>
      {table ? t('agent.usage.hideTable') : t('agent.usage.showTable')}
    </Button>
  )
  return (
    <div className="ag-usage__block">
      <div className="ag-usage__blockhead">
        <h3 className="ag-usage__subtitle">{t('agent.usage.last30')}</h3>
        {toggle}
      </div>
      {table ? (
        <div className="ag-usage__tablewrap">
          <table className="ag-usage__table">
            <caption className="ag-visually-hidden">{t('agent.usage.last30Label')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('agent.usage.day')}</th>
                <th scope="col">{t('agent.usage.total')}</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{dayLabel(row.key)}</th>
                  <td>{usageTokens(row).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="ag-bars" aria-label={t('agent.usage.last30Label')}>
          {report.rows.map((row, i) => {
            const label = t('agent.usage.dayBar', { day: dayLabel(row.key), count: usageTokens(row).toLocaleString() })
            return (
              <li key={row.key} className="ag-bars__slot" title={label} aria-label={label}>
                <span className="ag-bars__bar" style={{ height: `${Math.round((heights[i] ?? 0) * 100)}%` }} />
              </li>
            )
          })}
        </ul>
      )}
      {!table && report.rows.length > 1 && (
        <div className="ag-bars__axis" aria-hidden>
          <span>{dayLabel(report.rows[0]?.key ?? '')}</span>
          <span>{dayLabel(report.rows[report.rows.length - 1]?.key ?? '')}</span>
        </div>
      )}
    </div>
  )
}

function Breakdown({ title, report, limit = 5 }: { title: string; report: UsageReport; limit?: number }): ReactElement | null {
  const t = useT()
  const rows = report.rows.filter((r) => r.turns > 0).slice(0, limit)
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map(usageTokens))
  return (
    <div className="ag-usage__block" role="group" aria-label={title}>
      <h3 className="ag-usage__subtitle">{title}</h3>
      <ul className="ag-breakdown">
        {rows.map((row) => {
          const cost = formatEstimate(row.approxCostUsd)
          return (
            <li key={row.key} className="ag-breakdown__row">
              <span className="ag-breakdown__label" title={row.label}>
                {row.label}
              </span>
              <span className="ag-breakdown__track" aria-hidden>
                <span className="ag-breakdown__fill" style={{ width: `${Math.max(2, Math.round((usageTokens(row) / max) * 100))}%` }} />
              </span>
              <span className="ag-breakdown__value">
                {t('agent.usage.tokens', { count: formatTokens(usageTokens(row)) })}
                {cost && <span className="ag-breakdown__cost"> · {t('agent.usage.approx', { cost })}</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function UsageSection(): ReactElement {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  const usage = useResource(() => loadUsage(now), now, { keep: true })
  // Main sends `usage` at most every couple of seconds while replies come in.
  useEvent('usage', (e) => setNow(Math.max(e.at, Date.now())))

  let body: ReactElement
  if (usage.data === null) {
    body = usage.error ? (
      <ErrorState title={t('agent.usage.loadFailed')} message={usage.error} onRetry={usage.reload} />
    ) : (
      <div aria-busy="true" aria-label={t('agent.usage.loading')}>
        <SkeletonRows rows={4} />
      </div>
    )
  } else if (usage.data.month.totals.turns === 0 && usage.data.days.totals.turns === 0) {
    body = <EmptyState icon={<BarChart3 aria-hidden />} title={t('agent.usage.empty')} description={t('agent.usage.emptyHint')} compact />
  } else {
    const d = usage.data
    const m = d.month.totals
    body = (
      <>
        <div className="ag-usage__month">
          <span className="ag-usage__label">{t('agent.usage.thisMonth')}</span>
          <span className="ag-usage__big">{formatTokens(usageTokens(m))}</span>
          <span className="ag-usage__line">{totalsLine(t, m)}</span>
          <dl className="ag-usage__split">
            <div>
              <dt>{t('agent.usage.input')}</dt>
              <dd>{formatTokens(m.inputTokens)}</dd>
            </div>
            <div>
              <dt>{t('agent.usage.output')}</dt>
              <dd>{formatTokens(m.outputTokens)}</dd>
            </div>
            <div>
              <dt>{t('agent.usage.cache')}</dt>
              <dd>{formatTokens(m.cacheReadTokens + m.cacheWriteTokens)}</dd>
            </div>
          </dl>
        </div>
        <DayBars report={d.days} />
        <div className="ag-usage__grid">
          <Breakdown title={t('agent.usage.topChats')} report={d.chats} />
          <Breakdown title={t('agent.usage.byCompanion')} report={d.companions} />
          <Breakdown title={t('agent.usage.byModel')} report={d.models} />
          <Breakdown title={t('agent.usage.byKind')} report={d.kinds} />
        </div>
      </>
    )
  }

  return (
    <Section title={t('agent.usage.title')} note={t('agent.usage.note')}>
      <Card className="ag-usage">{body}</Card>
    </Section>
  )
}
