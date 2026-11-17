/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The extensions part of Settings › Import and the welcome step (ST-46 X):
// an "Extensions" choice beside bookmarks and history that, when ticked,
// lists the chosen Chromium profile's Web Store extensions as a checklist.
// Ones that aren't on the Chrome Web Store, or are already in Atelier, show
// but can't be picked. Main adds the picks after one confirmation and the
// report says what came over and what was left out.
import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { CircleCheck, Info, Puzzle } from 'lucide-react'
import { defaultExtensionPicks, pickableExtension, type ExtensionImportReport, type ImportableExtension } from '@shared/browserImport'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, CheckRow, Spinner, cx } from '../../ui'
import { useExtensions } from '../../extensions/useExtensions'
import { useResource } from '../data'
import { Notice } from '../kit'
import { allPicks, EXTENSION_SKIP_LABELS, keepPicks, reportHeadline, reportTone, togglePick, withInstalled } from '../logic/extensionImportFlow'
import '../../extensions/extImport.css'

export type ExtensionRunState = { kind: 'idle' } | { kind: 'running' } | { kind: 'done'; report: ExtensionImportReport } | { kind: 'failed'; message: string }

export interface ExtensionsPickerProps {
  browserId: string
  profileId: string
  on: boolean
  onToggle(on: boolean): void
  picks: string[]
  onPicks(picks: string[]): void
  disabled?: boolean
}

export function ExtensionsPicker({ browserId, profileId, on, onToggle, picks, onPicks, disabled = false }: ExtensionsPickerProps): ReactElement {
  const t = useT()
  const live = useExtensions()
  const found = useResource(() => call('browserImport', 'extensions', browserId, profileId), `${browserId}/${profileId}`)
  const installedIds = useMemo(() => new Set(live.items.map((e) => e.id)), [live.items])
  const list = useMemo(() => (found.data ? withInstalled(found.data, installedIds) : null), [found.data, installedIds])
  const seeded = useRef<string | null>(null)

  // A new profile's list: tick what was on there and isn't here yet; Extensions starts ticked when there is any.
  useEffect(() => {
    if (!found.data) return
    const key = `${browserId}/${profileId}`
    if (seeded.current === key) return
    seeded.current = key
    const start = defaultExtensionPicks(withInstalled(found.data, installedIds))
    onPicks(start)
    onToggle(start.length > 0)
  }, [found.data])

  // Something got installed meanwhile: drop it from the picks.
  useEffect(() => {
    if (!list) return
    const kept = keepPicks(picks, list)
    if (kept.length !== picks.length) onPicks(kept)
  }, [list])

  const pickable = list?.filter(pickableExtension).length ?? 0

  return (
    <div className="exi">
      <CheckRow label={t('extImport.type')} icon={<Puzzle />} checked={on && pickable > 0} disabled={disabled || pickable === 0} onChange={onToggle} />
      <p className="exi__hint sp-field__hint">
        {list === null ? (found.error ? t('extImport.loadFailed') : t('extImport.loading')) : list.length === 0 ? t('extImport.none') : t('extImport.type.explain')}
      </p>
      {on && list && list.length > 0 && (
        <div className="exi__list" role="group" aria-label={t('extImport.listLabel')}>
          {pickable > 3 && (
            <div className="exi__bulk">
              <span className="exi__count" aria-live="polite">
                {t('extImport.chosen', { count: picks.length })}
              </span>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onPicks(picks.length === pickable ? [] : allPicks(list))}>
                {picks.length === pickable ? t('extImport.selectNone') : t('extImport.selectAll')}
              </Button>
            </div>
          )}
          {list.map((ext) => (
            <ExtensionPickRow key={ext.id} ext={ext} checked={picks.includes(ext.id)} disabled={disabled} onChange={(checked) => onPicks(togglePick(picks, ext.id, checked, list))} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExtensionPickRow({ ext, checked, disabled, onChange }: { ext: ImportableExtension; checked: boolean; disabled: boolean; onChange(on: boolean): void }): ReactElement {
  const t = useT()
  const note = ext.installed ? t('extImport.installed') : !ext.onStore ? t('extImport.notOnStore') : !ext.enabled ? t('extImport.off') : null
  const meta = [ext.version ? t('extImport.version', { version: ext.version }) : null, note].filter(Boolean).join(' · ')
  const pickable = pickableExtension(ext)
  return (
    <div className={cx('exi__row', !pickable && 'exi__row--muted')}>
      <CheckRow className="exi__check" label={ext.name} checked={pickable && checked} disabled={disabled || !pickable} onChange={onChange} />
      {meta && <span className="exi__meta">{meta}</span>}
    </div>
  )
}

/** Adding progress, then what came over and what was left out. */
export function ExtensionImportStatus({ state, onRetry }: { state: ExtensionRunState; onRetry(): void }): ReactElement | null {
  const t = useT()
  if (state.kind === 'idle') return null
  if (state.kind === 'running') {
    return (
      <div className="sp-import__status" role="status" aria-live="polite">
        <Spinner size={14} />
        <span>{t('extImport.adding')}</span>
      </div>
    )
  }
  if (state.kind === 'failed') {
    return (
      <Notice tone="error" action={<Button size="sm" variant="secondary" onClick={onRetry}>{t('settings.retry')}</Button>}>
        {t('extImport.failed', { message: state.message })}
      </Notice>
    )
  }
  const { report } = state
  const headline = reportHeadline(report)
  const text =
    headline === 'cancelled'
      ? t('extImport.cancelled')
      : headline === 'added'
        ? t('extImport.added', { count: report.added.length, names: report.added.map((a) => a.name).join(', ') })
        : t('extImport.addedNone')
  const tone = reportTone(report)
  const skipped = report.skipped.map((s) => <li key={s.id}>{t(EXTENSION_SKIP_LABELS[s.reason], { name: s.name, message: s.message ?? '' })}</li>)
  if (tone === 'warning') {
    return (
      <Notice tone="warning">
        {text}
        <span className="exi__skipped-title">{t('extImport.skippedTitle')}</span>
        <ul className="sp-import__failures">{skipped}</ul>
      </Notice>
    )
  }
  return (
    <div className={cx('sp-import__status', tone === 'success' && 'sp-import__status--done')} role="status">
      {tone === 'success' ? <CircleCheck className="sp-icon--positive" aria-hidden /> : <Info aria-hidden />}
      <span>{text}</span>
    </div>
  )
}
