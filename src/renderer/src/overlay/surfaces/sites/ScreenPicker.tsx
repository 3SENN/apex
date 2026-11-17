/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { AppWindow, Monitor, MonitorUp, PanelTop, RotateCw, ShieldAlert } from 'lucide-react'
import type { ScreenPickerAnswer, ScreenPickerProps } from '@shared/overlay/sites'
import type { ScreenSource, ScreenSources } from '@shared/sites'
import { call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, EmptyState, ErrorState, SkeletonRows, Switch, TabList, TabPanel, useRovingFocus } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { groupSources, pickerGroup, type PickerGroup } from './logic'
import { useSiteRequest } from './parts'

// The screen-share picker (OV-14): a modal over the asking tab with tabs,
// windows and screens, each with a fresh thumbnail (or a placeholder) and its
// app icon or favicon. A click selects and a double-click shares; Enter
// shares the selected source. Cancel (or Esc) refuses this request. Windows
// and screens need macOS Screen Recording: opening either the first time
// asks macOS; after a refusal the picker says how to turn it on, and once it
// is on but needs a restart it offers Relaunch Apex. Coming back to the
// window looks again. Main closes the picker when its tab navigates or closes.

const GROUPS: { id: PickerGroup; label: 'sites.picker.tabs' | 'sites.picker.windows' | 'sites.picker.screens'; empty: 'sites.picker.noTabs' | 'sites.picker.noWindows' | 'sites.picker.noScreens'; Icon: typeof Monitor }[] = [
  { id: 'tab', label: 'sites.picker.tabs', empty: 'sites.picker.noTabs', Icon: PanelTop },
  { id: 'window', label: 'sites.picker.windows', empty: 'sites.picker.noWindows', Icon: AppWindow },
  { id: 'screen', label: 'sites.picker.screens', empty: 'sites.picker.noScreens', Icon: Monitor },
]

export function ScreenPicker({ props, resolve, close }: SurfaceComponentProps<ScreenPickerProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const idPrefix = useId()
  const [data, setData] = useState<ScreenSources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [group, setGroup] = useState<PickerGroup>('tab')
  const [selected, setSelected] = useState<string | null>(null)
  const [audio, setAudio] = useState(true)
  const [asking, setAsking] = useState(false)
  const asked = useRef(false)
  const grid = useRef<HTMLDivElement>(null)
  useSiteRequest(props.requestId, { onClosed: close })

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const next = await call('sites', 'screenSources', props.requestId)
      setData(next)
      setGroup((g) => pickerGroup(next.sources, g))
    } catch (err) {
      setError(errorText(err) || t('sites.picker.loadFailed'))
    }
  }, [props.requestId, t])

  useEffect(() => {
    void load()
  }, [load])

  const access = data?.screenAccess ?? null
  // Windows and screens need Screen Recording; tabs never do.
  const desktopReady = access === 'granted' || access === 'unsupported'

  // Back from System Settings (or the macOS prompt): look again while it isn't on yet.
  useEffect(() => {
    if (access === null || desktopReady) return
    const recheck = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [access, desktopReady, load])

  // Opening Windows or Screens is the moment to ask: macOS shows its prompt only the first time.
  useEffect(() => {
    if (group === 'tab' || access !== 'not-determined' || asked.current) return
    asked.current = true
    setAsking(true)
    void call('speech', 'requestScreen')
      .catch(() => undefined)
      .then(() => load())
      .finally(() => setAsking(false))
  }, [group, access, load])

  const groups = useMemo(() => groupSources(data?.sources ?? []), [data])
  const shown = groups[group]
  const chosen = data?.sources.find((s) => s.id === selected) ?? null
  const needsAccess = group !== 'tab' && data !== null && !desktopReady
  const audioApplies = props.audio && chosen !== null && chosen.kind !== 'window'

  const share = (source: ScreenSource | null): void => {
    if (!source) return
    const answer: ScreenPickerAnswer = { sourceId: source.id, audio: props.audio && audio && source.kind !== 'window' }
    resolve(answer)
  }

  const onGridKey = useRovingFocus(grid, { selector: '[role="option"]', onMove: (el) => setSelected(el.dataset.sourceId ?? null) })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' || !chosen || (e.target as HTMLElement).closest('button, input, [role="tab"]')) return
    e.preventDefault()
    share(chosen)
  }

  return (
    <div className="st-scrim">
      <div className="st-card st-modal st-picker" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="st-modal__head">
          <span className="st-prompt__glyph" aria-hidden>
            <MonitorUp size={16} />
          </span>
          <h2 id={titleId} className="st-modal__title">
            {t('sites.picker.title', { host: props.host })}
          </h2>
        </header>

        <TabList
          idPrefix={idPrefix}
          label={t('sites.picker.title', { host: props.host })}
          value={group}
          onChange={(id) => setGroup(id as PickerGroup)}
          tabs={GROUPS.map((g) => ({ id: g.id, label: t(g.label), icon: <g.Icon size={14} aria-hidden /> }))}
        />

        <TabPanel idPrefix={idPrefix} tabId={group} className="st-picker__panel">
          {error ? (
            <ErrorState compact title={t('sites.picker.loadFailed')} message={error} retryLabel={t('sites.info.retry')} onRetry={load} />
          ) : !data ? (
            <SkeletonRows rows={3} label={t('sites.picker.title', { host: props.host })} />
          ) : needsAccess && (asking || access === 'not-determined') ? (
            <div className="st-note st-picker__access" role="status">
              <ShieldAlert size={14} aria-hidden />
              <p>{t('sites.picker.accessAsking')}</p>
            </div>
          ) : needsAccess && access === 'relaunch' ? (
            <div className="st-note st-note--warn st-picker__access" role="note">
              <RotateCw size={14} aria-hidden />
              <div>
                <p>{t('sites.picker.accessRelaunch')}</p>
                <Button size="sm" onClick={() => void call('speech', 'relaunch')}>
                  {t('sites.picker.relaunch')}
                </Button>
              </div>
            </div>
          ) : needsAccess ? (
            <div className="st-note st-note--warn st-picker__access" role="note">
              <ShieldAlert size={14} aria-hidden />
              <div>
                <p>{t('sites.picker.access')}</p>
                <Button size="sm" onClick={() => void call('sites', 'openSystemSettings', 'screen')}>
                  {t('sites.prompt.openSystem')}
                </Button>
              </div>
            </div>
          ) : shown.length === 0 ? (
            <EmptyState compact icon={<Monitor size={20} aria-hidden />} title={t(GROUPS.find((g) => g.id === group)!.empty)} />
          ) : (
            <div ref={grid} className="st-sources" role="listbox" aria-label={t(GROUPS.find((g) => g.id === group)!.label)} onKeyDown={onGridKey}>
              {shown.map((source, i) => {
                const isSelected = source.id === selected
                const focusable = isSelected || (!shown.some((s) => s.id === selected) && i === 0)
                return (
                  <div
                    key={source.id}
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={focusable ? 0 : -1}
                    data-source-id={source.id}
                    className="st-source"
                    onClick={() => setSelected(source.id)}
                    onDoubleClick={() => share(source)}
                    onFocus={() => setSelected(source.id)}
                  >
                    <span className="st-source__thumb">
                      {source.thumbnail ? <img src={source.thumbnail} alt="" draggable={false} /> : <span className="st-source__placeholder">{t('sites.picker.noPreview')}</span>}
                    </span>
                    <span className="st-source__label">
                      {source.icon ? <img className="st-source__icon" src={source.icon} alt="" width={16} height={16} draggable={false} /> : null}
                      <span className="st-source__name">{source.name}</span>
                    </span>
                    {source.detail && <span className="st-source__detail st-muted st-small">{source.detail}</span>}
                  </div>
                )
              })}
            </div>
          )}
        </TabPanel>

        <footer className="st-actions st-modal__foot">
          {props.audio && <Switch size="sm" checked={audio && audioApplies} disabled={!audioApplies} onChange={setAudio} label={t('sites.picker.tabAudio')} className="st-picker__audio" />}
          <span className="st-row__grow" />
          <Button variant="secondary" size="sm" onClick={close}>
            {t('sites.picker.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={!chosen || (chosen.kind !== 'tab' && !desktopReady)} onClick={() => share(chosen)}>
            {t('sites.picker.share')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
