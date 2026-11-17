/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Memory (ST-47, ST-48): two blocks, the shared notes every
// companion reads and one companion's own notes (pick a companion, then its
// files), each with a Markdown preview and Edit, Build from past chats,
// Reorganize and Delete all; then Tidy memory, the optional nightly pass.
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { MemoryJob } from '@shared/activity'
import { SHARED_OWNER } from '@shared/chats'
import type { SettingsView } from '@shared/ipc'
import { MemoryBlock } from '../../activity/MemoryBlock'
import { TidySettings } from '../../activity/TidySettings'
import { upsertJob } from '../../activity/logic'
import '../../activity/activity.css'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, Select } from '../../ui'
import { useCompanions, useEvent } from '../data'
import { Notice, PageHeader, Section } from '../kit'

export function MemoryPage({ settings, onOpenModel }: { settings: SettingsView; onOpenModel(): void }): ReactElement {
  const t = useT()
  const companions = useCompanions()
  const [companionId, setCompanionId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<MemoryJob[]>([])

  useEffect(() => {
    let live = true
    call('memory', 'jobs').then(
      (list) => live && setJobs(list),
      // Without the job list the blocks still work; progress arrives as events.
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  useEvent('memory-job', (e) => setJobs((list) => upsertJob(list, e.job)))
  const onJob = useCallback((job: MemoryJob) => setJobs((list) => upsertJob(list, job)), [])

  // Start on the active companion; a removed companion falls back to the first one.
  const items = companions.items ?? []
  useEffect(() => {
    if (items.length === 0) return
    if (companionId === null || !items.some((c) => c.id === companionId)) setCompanionId(items.some((c) => c.id === companions.activeId) ? companions.activeId : (items[0]?.id ?? null))
  }, [items, companions.activeId, companionId])

  const companion = items.find((c) => c.id === companionId) ?? null
  const companionName = (id: string): string => items.find((c) => c.id === id)?.name ?? t('memory.memory.companion')

  return (
    <>
      <PageHeader title={t('memory.memory.title')} description={t('memory.memory.description')} />
      {!settings.memory && (
        <Notice
          tone="info"
          action={
            <Button size="sm" variant="ghost" onClick={onOpenModel}>
              {t('memory.memory.openModel')}
            </Button>
          }
        >
          {t('memory.memory.off')}
        </Notice>
      )}

      <Section title={t('memory.memory.shared')} note={t('memory.memory.sharedNote')}>
        <MemoryBlock owner={SHARED_OWNER} whose={t('memory.memory.whoseShared')} jobs={jobs} engine={settings.engine} onJob={onJob} />
      </Section>

      <Section
        title={t('memory.memory.companion')}
        note={t('memory.memory.companionNote')}
        actions={
          items.length > 0 && companionId ? (
            <Select<string>
              size="sm"
              aria-label={t('memory.memory.pickCompanion')}
              value={companionId}
              options={items.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setCompanionId}
            />
          ) : undefined
        }
      >
        {companion ? (
          <MemoryBlock key={companion.id} owner={companion.id} whose={t('memory.memory.whoseCompanion', { name: companion.name })} jobs={jobs} engine={settings.engine} onJob={onJob} />
        ) : (
          companions.items !== null && <p className="am-muted">{t('memory.memory.noCompanions')}</p>
        )}
      </Section>

      <Section title={t('memory.tidy.title')}>
        <TidySettings companionName={companionName} />
      </Section>
    </>
  )
}
