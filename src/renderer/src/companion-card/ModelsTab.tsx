/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useId, type ReactElement, type ReactNode } from 'react'
import { Cpu, Gauge, Sparkles } from 'lucide-react'
import type { Companion, CompanionEffort } from '@shared/companion'
import { call } from '../api'
import { useCompanionEngine } from '../settings/pages/ModelAndKeyPage'
import { SaveStatus, Select } from '../ui'
import { ListTabHeader } from './ListTab'
import { chatDefaults, EFFORT_CHOICES, effortLabel, MODEL_CHOICES, modelLabel } from './logic/models'
import { useSettingsView } from './useLoaded'
import { useSaveTracker } from './useSaveTracker'
import { useT } from '../i18n/useT'

const GLOBAL = 'global'

// The Models tab (DS-117): each setting is a 60 px row with a grey glyph
// tile, a title over a muted one-line description, and a 200×32 hairline
// pill picker on the right. A footer line says which choice wins and links
// to Settings › Model and key.

function SettingRow({ glyph, title, description, picker, labelId }: { glyph: ReactNode; title: string; description: string; picker: ReactNode; labelId: string }): ReactElement {
  return (
    <li className="co-setting-row">
      <span className="co-setting-row__tile" aria-hidden="true">
        {glyph}
      </span>
      <span className="co-setting-row__text">
        <span className="co-setting-row__title" id={labelId}>
          {title}
        </span>
        <span className="co-setting-row__description">{description}</span>
      </span>
      <span className="co-setting-row__picker">{picker}</span>
    </li>
  )
}

/** Default model, effort and engine for this companion's new chats. */
export function ModelsTab({ companion, onOpenPage }: { companion: Companion; onOpenPage(url: string): void }) {
  const t = useT()
  const settings = useSettingsView()
  const saving = useSaveTracker()
  const engine = useCompanionEngine(companion)
  const ids = { model: useId(), effort: useId(), engine: useId() }
  const global = { model: settings?.model ?? '', effort: settings?.effort ?? '' }
  const defaults = chatDefaults(companion, global)
  const update = (patch: { model?: string | null; effort?: CompanionEffort | null }): void => saving.run(() => call('companions', 'update', companion.id, patch))
  const yourDefault = (label: string): string => (settings ? t('coCard.models.yourDefault', { label }) : t('coCard.models.yourDefault2'))

  return (
    <div className="co-tab co-models">
      <ListTabHeader
        title={t('coCard.models.models')}
        help={
          <>
            {t('coCard.models.aModelOrEffort', { name: companion.name })}
          </>
        }
        extra={<SaveStatus state={saving.state} onRetry={saving.retry} />}
      />
      <ul className="co-setting-rows">
        <SettingRow
          glyph={<Sparkles />}
          title={t('coCard.models.model')}
          labelId={ids.model}
          description={t('coCard.models.thinksWith', { name: companion.name })}
          picker={
            <Select
              aria-label={t('coCard.models.model')}
              size="sm"
              className="co-pill-select"
              value={companion.model ?? GLOBAL}
              onChange={(v) => update({ model: v === GLOBAL ? null : v })}
              options={[{ value: GLOBAL, label: yourDefault(modelLabel(global.model)) }, ...MODEL_CHOICES.map((m) => ({ value: m.id, label: `${m.label} (${m.note})` }))]}
            />
          }
        />
        <SettingRow
          glyph={<Gauge />}
          title={t('coCard.models.effort')}
          labelId={ids.effort}
          description={t('coCard.models.moreEffortMeansMore')}
          picker={
            <Select
              aria-label={t('coCard.models.effort')}
              size="sm"
              className="co-pill-select"
              value={companion.effort ?? GLOBAL}
              onChange={(v) => update({ effort: v === GLOBAL ? null : (v as CompanionEffort) })}
              options={[{ value: GLOBAL, label: yourDefault(effortLabel(global.effort)) }, ...EFFORT_CHOICES.map((e) => ({ value: e.id, label: e.label }))]}
            />
          }
        />
        {/* ST-58: the companion's own engine; shown only where the build offers more than the API key. */}
        {engine.visible && (
          <SettingRow
            glyph={<Cpu />}
            title={t('coCard.models.engine')}
            labelId={ids.engine}
            description={t('coCard.models.engineFor', { name: companion.name })}
            picker={<Select aria-label={t('coCard.models.engine')} size="sm" className="co-pill-select" value={engine.value} onChange={engine.onChange} options={engine.options} />}
          />
        )}
      </ul>
      <div className="co-models__footer">
        <p className="co-models__note">
          {settings ? (
            <>
              {t('coCard.models.newChatsStartOn', { value: modelLabel(defaults.model), value2: effortLabel(defaults.effort).toLowerCase() })}
            </>
          ) : (
            t('coCard.models.changesHereApplyTo')
          )}
        </p>
        <button type="button" className="co-ink-pill co-ink-pill--sm" onClick={() => onOpenPage('apex://settings/model')}>
          {t('coCard.models.openModelAndKey')}
        </button>
      </div>
    </div>
  )
}
