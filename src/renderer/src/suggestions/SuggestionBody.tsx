/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a site suggestion offers (OV-23), shared by the panel card and the
// toolbar popover: connect a service, or one to three ready-made tasks
// drafted into the attached chat or a new one; open in the desktop app;
// and the ways to say no (not now, snooze, off for this site, off everywhere).
import { useState, type ReactElement } from 'react'
import { AppWindow, ArrowUpRight, PenLine, Plug, X } from 'lucide-react'
import type { SiteSuggestion, SuggestionDismissScope } from '@shared/siteSuggestions'
import { call, errorText } from '../api'
import { t } from '../i18n/useT'
import { Button, IconButton, cx, showMenu, toast } from '../ui'
import { draftSuggestionTask } from './suggestionData'
import '../apps/platform.css'

const DAY_MS = 24 * 60 * 60_000

export function hostLabel(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '')
  } catch {
    return origin
  }
}

export function SuggestionBody({ suggestion, chatId, variant, onDone }: { suggestion: SiteSuggestion; chatId: string | null; variant: 'card' | 'popover'; onDone?(): void }): ReactElement {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = suggestion.name ?? suggestion.app ?? hostLabel(suggestion.origin)
  const host = hostLabel(suggestion.origin)
  const toConnect = suggestion.kind === 'connector' && suggestion.directoryId !== undefined

  const draft = async (task: SiteSuggestion['tasks'][number]): Promise<void> => {
    setBusy(task.id)
    setError(null)
    try {
      await draftSuggestionTask(suggestion.tabId, task, chatId)
      onDone?.()
    } catch (err) {
      setError(t('platform.suggestion.draftFailed', { reason: errorText(err) }))
    } finally {
      setBusy(null)
    }
  }
  const connect = async (): Promise<void> => {
    if (!suggestion.directoryId) return
    setBusy('connect')
    setError(null)
    try {
      await call('connectors', 'connectDirectory', suggestion.directoryId)
      toast.show({ tone: 'success', message: t('platform.suggestion.connected', { name }) })
      onDone?.()
    } catch (err) {
      setError(t('platform.suggestion.connectFailed', { reason: errorText(err) }))
    } finally {
      setBusy(null)
    }
  }
  const openInApp = async (): Promise<void> => {
    try {
      const opened = await call('siteSuggestions', 'openInApp', suggestion.tabId)
      if (!opened) setError(t('platform.applink.notInstalled', { app: suggestion.app ?? name }))
      else onDone?.()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const dismiss = async (anchor: HTMLElement): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'once', label: t('platform.suggestion.notNow') },
        { id: 'snooze', label: t('platform.suggestion.snooze') },
        { id: 'site', label: t('platform.suggestion.offSite', { host }) },
        { id: 'everywhere', label: t('platform.suggestion.offEverywhere') },
      ],
      anchor,
    )
    if (!choice) return
    const scope: SuggestionDismissScope = choice === 'snooze' ? { snoozeUntil: Date.now() + DAY_MS } : (choice as 'once' | 'site' | 'everywhere')
    try {
      await call('siteSuggestions', 'dismiss', suggestion.tabId, scope)
      if (choice === 'everywhere') toast.show({ message: t('platform.suggestion.offEverywhereDone') })
      onDone?.()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className={cx('pl-suggest', variant === 'popover' && 'pl-suggest--popover')} role="group" aria-label={t('platform.suggestion.title')}>
      <div className="pl-suggest__head">
        <div className="pl-suggest__titles">
          <p className="pl-suggest__kicker">{t('platform.suggestion.title')}</p>
          <p className="pl-suggest__title">
            {toConnect ? t('platform.suggestion.connectTitle', { name }) : suggestion.kind === 'connector' ? t('platform.suggestion.connectorTitle', { name }) : t('platform.suggestion.appTitle', { name })}
          </p>
          {toConnect && <p className="pl-card__sub">{t('platform.suggestion.connectDetail', { name })}</p>}
        </div>
        <IconButton size="sm" label={t('platform.suggestion.dismiss')} aria-haspopup="menu" icon={<X />} onClick={(e) => void dismiss(e.currentTarget)} />
      </div>
      {suggestion.tasks.length > 0 && (
        <ul className="pl-suggest__tasks">
          {suggestion.tasks.map((task) => (
            <li key={task.id}>
              <button type="button" className="pl-suggest__task" aria-busy={busy === task.id} disabled={busy !== null} onClick={() => void draft(task)} title={task.prompt}>
                <PenLine aria-hidden />
                <span>{task.title}</span>
                <ArrowUpRight aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      {(toConnect || suggestion.kind === 'app-link') && (
        <div className="pl-card__actions">
          {toConnect && (
            <Button size="sm" variant="primary" icon={<Plug />} loading={busy === 'connect'} onClick={() => void connect()}>
              {t('platform.suggestion.connect', { name })}
            </Button>
          )}
          {suggestion.kind === 'app-link' && suggestion.app && (
            <Button size="sm" icon={<AppWindow />} onClick={() => void openInApp()}>
              {t('platform.applink.open', { app: suggestion.app })}
            </Button>
          )}
        </div>
      )}
      {suggestion.tasks.length > 0 && <p className="pl-faint" style={{ margin: 0, fontSize: 'var(--text-xs)' }}>{chatId ? t('platform.suggestion.draftsHere') : t('platform.suggestion.draftsNew')}</p>}
      {error && (
        <p className="pl-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
