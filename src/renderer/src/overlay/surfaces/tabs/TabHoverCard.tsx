/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { TabHoverCardProps } from '@shared/overlay/tabs'
import type { ChatPreview } from '@shared/services/chat'
import { CalendarClock, ChevronRight } from 'lucide-react'
import { useT, type T } from '../../../i18n/useT'
import { RelativeTime, cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { PageFavicon, PageThumb, useCardLifetime, useGlide } from './cardParts'

// The row and tab hover card (SH-28, DS-92): a tab's thumbnail, title
// and host; both pages of a split pair; a chat's latest request, reply and
// progress; or the Routines row's upcoming runs. It sits right of a sidebar
// row or below a strip tab, glides between rows, and leaves shortly after
// the pointer does unless the pointer is on the card.

function sourceLabel(t: T, source: NonNullable<ChatPreview['lastRequest']>['source']): string {
  switch (source) {
    case 'routine':
      return t('tabs.card.source.routine')
    case 'voice':
      return t('tabs.card.source.voice')
    case 'selection':
      return t('tabs.card.source.selection')
    default:
      return t('tabs.card.source.you')
  }
}

function ChatCard({ props, t }: { props: Extract<TabHoverCardProps, { kind: 'chat' }>; t: T }): ReactElement {
  const p = props.preview
  const kind = p?.kind === 'routine-run' ? t('tabs.card.kind.routineRun') : p?.kind === 'agent-task' ? t('tabs.card.kind.agentTask') : t('tabs.card.kind.chat')
  const progress = p ? { idle: null, working: t('tabs.card.progress.working'), 'needs-you': t('tabs.card.progress.needsYou'), done: t('tabs.card.progress.done'), error: t('tabs.card.progress.error') }[p.progress] : null
  return (
    <>
      <div className="tab-card__eyebrow">
        <span>{kind}</span>
        {progress && <span className={cx('tab-card__progress', p && `tab-card__progress--${p.progress}`)}>{progress}</span>}
      </div>
      <div className="tab-card__title tab-card__title--chat">{props.title || t('tabs.card.untitledChat')}</div>
      {p?.lastRequest && (
        <div className="tab-card__bubble">
          <span className="tab-card__bubble-source">{sourceLabel(t, p.lastRequest.source)}</span>
          {p.lastRequest.text}
        </div>
      )}
      {p?.replySnippet && <div className="tab-card__reply">{p.replySnippet}</div>}
      {p && p.pending.length > 0 && (
        <ul className="tab-card__pending" aria-label={t('tabs.card.pendingLabel')}>
          {p.pending.slice(0, 3).map((item, i) => (
            <li key={i} className={`tab-card__pending-item tab-card__pending-item--${item.kind}`}>
              {item.label}
            </li>
          ))}
          {p.pendingCount > 3 && <li className="tab-card__more">{t('tabs.card.morePending', { count: p.pendingCount - 3 })}</li>}
        </ul>
      )}
      {p?.nextRunAt && (
        <div className="tab-card__next">
          <CalendarClock size={12} aria-hidden />
          {t('tabs.card.nextRun')} <RelativeTime value={p.nextRunAt} style="short" />
        </div>
      )}
      {!p && <div className="tab-card__reply tab-card__reply--empty">{t('tabs.card.noPreview')}</div>}
    </>
  )
}

export function TabHoverCard({ props, close, resolve }: SurfaceComponentProps<TabHoverCardProps>): ReactElement {
  const t = useT()
  const glide = useGlide(props.glideFrom)
  const life = useCardLifetime(props.leaving, close)
  return (
    <div className={cx('tab-card', `tab-card--${props.kind}`, `tab-card--${props.side}`)} style={glide} {...life} role="dialog" aria-label={t('tabs.card.label')}>
      {props.kind === 'tab' && (
        <>
          <PageThumb page={props.page} className={props.live ? 'tab-card__thumb--live' : undefined} />
          <div className="tab-card__title">{props.page.title}</div>
          <div className="tab-card__host">
            <PageFavicon src={props.page.favicon} />
            <span>{props.page.host}</span>
          </div>
        </>
      )}
      {props.kind === 'split' && (
        <>
          <div className="tab-card__eyebrow">{t('tabs.card.kind.split')}</div>
          <div className="tab-card__pair">
            {props.pages.map((page) => (
              <div key={page.tabId} className="tab-card__half">
                <PageThumb page={page} />
                <div className="tab-card__title tab-card__title--small">{page.title}</div>
                <div className="tab-card__host">
                  <PageFavicon src={page.favicon} size={12} />
                  <span>{page.host}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {props.kind === 'chat' && <ChatCard props={props} t={t} />}
      {props.kind === 'routines' && (
        <>
          <div className="tab-card__eyebrow">{t('tabs.card.upcoming')}</div>
          {props.runs.length === 0 ? (
            <div className="tab-card__reply tab-card__reply--empty">{t('tabs.card.noRuns')}</div>
          ) : (
            <ul className="tab-card__runs">
              {props.runs.slice(0, 8).map((run) => (
                <li key={`${run.id}:${run.at}`}>
                  <button type="button" className="tab-card__run" onClick={() => resolve({ routineId: run.id })}>
                    <span className="tab-card__run-name">{run.name}</span>
                    <RelativeTime value={run.at} style="short" className="tab-card__run-time" />
                    <ChevronRight size={12} aria-hidden />
                  </button>
                </li>
              ))}
              {props.more > 0 && <li className="tab-card__more">{t('tabs.card.moreRuns', { count: props.more })}</li>}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
