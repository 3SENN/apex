/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Model and key, and Settings › Agent permissions.
import type { ReactElement } from 'react'
import type { Effort, SettingsPatch, SettingsView } from '@shared/ipc'
import { useT } from '../../i18n/useT'
import { t as tx, type MessageKey } from '@shared/i18n/core'
import { SegmentedControl, Select, Switch } from '../../ui'
import { ApiKeyCard } from '../ApiKeyCard'
import { CalendarAccessCard } from '../cards/CalendarAccessCard'
import { Card, PageHeader, Row, Section } from '../kit'
import { EngineSections } from './ModelAndKeyPage'
// ST-12, ST-13
import { ApprovalModeSection } from '../agent/ApprovalModeSection'
import { PromptViewerRow } from '../agent/PromptViewer'
import { SavedPermissions, SiteDefaultSection } from '../agent/SavedPermissions'
import { UsageSection } from '../agent/UsageSection'
import { QuickDecisionsSummary } from '../agent/QuickDecisions' // docs/decisions.md
import '../agent/agent.css'
import { PermissionsLink } from '../permissions/PermissionsLink'

// Labels are read when the page draws, so they follow the app language.
const MODEL_KEYS = [
  { value: 'claude-opus-5-5', key: 'settings.model.option.opus' },
  { value: 'claude-sonnet-5-5', key: 'settings.model.option.sonnet' },
  { value: 'claude-haiku-5-5', key: 'settings.model.option.haiku' },
  { value: 'claude-fable-5-1', key: 'settings.model.option.fable' },
] as const satisfies ReadonlyArray<{ value: string; key: MessageKey }>

export const MODEL_OPTIONS: ReadonlyArray<{ readonly value: (typeof MODEL_KEYS)[number]['value']; readonly label: string }> = MODEL_KEYS.map(({ value, key }) => ({
  value,
  get label() {
    return tx(key)
  },
}))

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const EFFORT_OPTIONS: ReadonlyArray<{ readonly value: Effort; readonly label: string; readonly title: string }> = EFFORTS.map((value) => ({
  value,
  get label() {
    return tx(`settings.model.effort.${value}`)
  },
  get title() {
    return tx(`settings.model.effort.${value}.title`)
  },
}))

interface PageProps {
  settings: SettingsView
  update(patch: SettingsPatch): void
  onSettings(view: SettingsView): void
  onOpenSection?(page: string): void
}

export function ModelPage({ settings, update, onSettings, onOpenSection }: PageProps): ReactElement {
  const t = useT()
  const known = MODEL_OPTIONS.some((m) => m.value === settings.model)
  return (
    <>
      <PageHeader title={t('settings.model.title')} description={t('settings.model.description')} />
      <EngineSections settings={settings} update={update} />
      <Section title={t('settings.model.apiKey')}>
        <ApiKeyCard settings={settings} onSettings={onSettings} />
      </Section>
      <Section title={t('settings.model.defaults')} note={t('settings.model.defaults.note')}>
        <Card>
          <Row title={t('settings.model.model')} htmlFor="settings-model">
            <Select
              id="settings-model"
              value={settings.model}
              options={known ? MODEL_OPTIONS : [{ value: settings.model, label: settings.model }, ...MODEL_OPTIONS]}
              onChange={(model) => update({ model })}
            />
          </Row>
          <Row title={t('settings.model.effort')} description={t('settings.model.effort.description')}>
            <SegmentedControl label={t('settings.model.effort')} size="sm" options={EFFORT_OPTIONS} value={settings.effort} onChange={(effort) => update({ effort })} />
          </Row>
        </Card>
      </Section>
      <Section title={t('settings.model.abilities')} note={t('settings.model.abilities.note')}>
        <Card>
          <Switch
            label={t('settings.abilities.webTools.label')}
            description={t('settings.abilities.webTools.description')}
            checked={settings.webTools}
            onChange={(webTools) => update({ webTools })}
          />
          <Switch
            label={t('settings.model.memory')}
            description={t('settings.model.memory.description')}
            checked={settings.memory}
            onChange={(memory) => update({ memory })}
          />
          {/* Files and documents. */}
          <Switch
            label={t('settings.abilities.documents.label')}
            description={t('settings.abilities.documents.description')}
            checked={settings.documents}
            onChange={(documents) => update({ documents })}
          />
        </Card>
      </Section>
      {/* docs/decisions.md: its own page; here only whether it is on. */}
      <QuickDecisionsSummary settings={settings} onOpen={() => onOpenSection?.('decisions')} />
      <Section title={t('agent.prompt.title')}>
        <PromptViewerRow />
      </Section>
      <UsageSection />
    </>
  )
}

/**
 * Settings › Agent permissions (ST-12, ST-13): the approval mode, what sites
 * without a rule get, this Mac's calendar access (a card of its own), and every
 * saved permission, each revocable. Changes apply at the agent's next step.
 */
export function PermissionsPage({ settings, update }: Omit<PageProps, 'onSettings'>): ReactElement {
  const t = useT()
  return (
    <>
      <PageHeader title={t('settings.permissions.title')} description={t('settings.permissions.description')} />
      <ApprovalModeSection settings={settings} update={update} />
      <SiteDefaultSection settings={settings} update={update} />
      <Section title={t('agent.thisMac.title')} actions={<PermissionsLink />}>
        <CalendarAccessCard />
      </Section>
      <SavedPermissions />
    </>
  )
}
