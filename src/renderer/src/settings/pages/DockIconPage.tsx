/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Dock icon (ST-09, macOS): a radio group of Apex's own icon and
// each companion. Choosing a companion draws its head and hands it to the
// Dock; the status line spins until main says the Dock changed. Main keeps
// the old per-companion flag in step and falls back to the standard icon
// when the chosen companion is deleted.
import { useEffect, useState, type ReactElement } from 'react'
import { useT } from '../../i18n/useT'
import { AppIconImage } from '../../brand/BrandLogo'
import { Spinner } from '../../ui'
import { CompanionAvatar } from '../companions/CompanionAvatar'
import { useCompanions, useEvent } from '../data'
import { applyDockChoice } from '../dockChoice'
import { chosenCompanion, DOCK_STANDARD, dockChoiceFor, dockValue } from '../logic/dock'
import { Card, ChoiceTiles, Notice, PageError, PageHeader, PageSkeleton, Section, type ChoiceTile } from '../kit'
import type { SettingsPageProps } from '../pageTypes'
import { apex } from '../../api'
import { DockDesigner } from '../dock/DockDesigner'

type Status = { kind: 'idle' } | { kind: 'updating' } | { kind: 'done'; name: string | null } | { kind: 'failed'; message: string }

export function DockIconPage({ settings, update }: Pick<SettingsPageProps, 'settings' | 'update'>): ReactElement {
  const t = useT()
  const companions = useCompanions()
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const choice = settings.dockIcon

  // Main reports when the Dock actually changed.
  useEvent('dock-icon', (e) => {
    const name = e.kind === 'companion' ? companions.items?.find((c) => c.id === e.companionId)?.name ?? null : null
    setStatus({ kind: 'done', name })
  })
  // A deleted choice falls back on main's side; drop a spinner that would never end.
  useEffect(() => {
    if (status.kind === 'updating' && choice.kind === 'standard') setStatus({ kind: 'done', name: null })
  }, [choice.kind])

  const header = <PageHeader title={t('settings.dock.title')} description={t('settings.dock.description')} />
  if (companions.items === null) {
    return (
      <>
        {header}
        {companions.error ? <PageError title={t('settings.loadFailed')} message={companions.error} onRetry={companions.reload} /> : <PageSkeleton label={t('settings.kit.loading')} rows={2} />}
      </>
    )
  }

  const items = companions.items
  const options: ChoiceTile<string>[] = [
    { value: DOCK_STANDARD, title: t('settings.dock.standard'), art: <AppIconImage size={72} className="sp-dock-art__icon" /> },
    ...items.map((c) => ({
      value: c.id,
      title: c.name,
      description: c.hidden ? t('settings.dock.hidden') : undefined,
      art: <CompanionAvatar look={c.look} name={c.name} size={72} dimmed={c.hidden} />,
    })),
  ]

  const choose = async (value: string): Promise<void> => {
    if (value === dockValue(choice)) return
    const next = dockChoiceFor(value)
    setStatus({ kind: 'updating' })
    try {
      await update({ dockIcon: next })
      const target = chosenCompanion(next, items)
      // The standard icon is main's own; a companion's head is drawn here.
      if (target) await applyDockChoice(target)
    } catch (err) {
      setStatus({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const current = chosenCompanion(choice, items)
  return (
    <>
      {header}
      <Section title={t('settings.dock.choice')} note={t('settings.dock.note')}>
        <Card className="sp-dock">
          <div data-settings-anchor="dock-icon">
            <ChoiceTiles label={t('settings.dock.choice')} value={dockValue(choice)} options={options} onChange={(v) => void choose(v)} />
          </div>
        </Card>
        <p className="sp-dock__status" role="status" aria-live="polite">
          {status.kind === 'updating' && (
            <>
              <Spinner size={14} /> {t('settings.dock.updating')}
            </>
          )}
          {status.kind === 'done' && (status.name ?? current?.name ? t('settings.dock.updated', { name: status.name ?? current?.name ?? '' }) : t('settings.dock.standardSet'))}
        </p>
        {status.kind === 'failed' && <Notice tone="error">{status.message}</Notice>}
      </Section>
      {/* ST-10: shown while a companion is the Dock icon, macOS only */}
      {apex.platform === 'darwin' && current && (
        <Section title={t('firstRun.dock.designTitle')} note={t('firstRun.dock.designNote')}>
          <Card>
            <DockDesigner companions={items.filter((c) => !c.hidden)} chosenId={current.id} />
          </Card>
        </Section>
      )}
    </>
  )
}
