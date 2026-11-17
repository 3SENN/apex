/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Model and key: which engine powers the companions (ST-58) when
// the build offers more than the API key, those engines' own sections
// (`@internal/engines/renderer`), and letting Claude Code, or another MCP
// client, outside Apex use its browser tools (ST-60). There are no plans,
// credits or quotas in Apex: this status takes their place.
import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, Copy, KeyRound, ShieldCheck, SquareTerminal, Unplug } from 'lucide-react'
import { ENGINE_UI } from '@internal/engines/renderer'
import type { Companion } from '@shared/companion'
import { ENGINE_LABELS, hasEngineChoice, type EngineId, type EngineStatus } from '@shared/engine'
import type { SettingsPatch, SettingsView } from '@shared/ipc'
import { call, errorText } from '../../api'
import type { EngineChoiceSpec } from '../../engines/seam'
import { useEngineStatus } from '../../engines/useEngineStatus'
import { Badge, Button, SegmentedControl, Select, Spinner, Switch, cx, useConfirm, useToast } from '../../ui'
import { Card, Notice, Row, Section } from '../kit'
import { engineBadge } from '../logic/engine'
import './modelAndKey.css'
import { useT, t } from '../../i18n/useT'

export { useEngineStatus }

interface PageProps {
  settings: SettingsView
  update(patch: SettingsPatch): void
}

/** Everything engine-related on the page, above the key and model defaults. */
export function EngineSections({ settings, update }: PageProps): ReactElement | null {
  const t = useT()
  const status = useEngineStatus()
  const Sections = ENGINE_UI.Sections
  return (
    <>
      {/* The choice only when the build offers more than the API key. */}
      {(!status || hasEngineChoice(status)) && ENGINE_UI.choices.length > 0 && (
        <Section title={t('settings.modelAndKey.engine')} note={t('settings.modelAndKey.newChatsUseThis')}>
          <EngineChoice status={status} value={settings.engine} onChange={(engine) => update({ engine })} />
        </Section>
      )}
      {Sections && <Sections status={status} settings={settings} update={update} />}
      <Section title={t('settings.modelAndKey.letClaudeCodeUse')}>
        <OutsideAccessCard status={status} settings={settings} update={update} />
      </Section>
    </>
  )
}

/** The API key, then the engines the build adds (read when drawn, so the seam is loaded). */
const choices = (): readonly EngineChoiceSpec[] => [{ id: 'api-key', icon: <KeyRound />, description: t('settings.modelAndKey.yourCompanionsTalkTo') }, ...ENGINE_UI.choices]

/** Radio cards with live status. Arrow keys move the choice, like any radio group. */
export function EngineChoice({ status, value, onChange }: { status: EngineStatus | null; value: EngineId; onChange(engine: EngineId): void }): ReactElement {
  const t = useT()
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const CHOICES = choices()
  const onKey = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + CHOICES.length) % CHOICES.length
    refs.current[next]?.focus()
    const choice = CHOICES[next]
    if (choice) onChange(choice.id)
  }
  return (
    <div className="mk-choices" role="radiogroup" aria-label={t('settings.modelAndKey.engineForNewChats')}>
      {CHOICES.map((choice, i) => {
        const selected = choice.id === value
        const badge = status ? engineBadge(status, choice.id) : null
        return (
          <button
            key={choice.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={cx('mk-choice', selected && 'mk-choice--selected')}
            onClick={() => onChange(choice.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            <span className="mk-choice__icon" aria-hidden>
              {choice.icon}
            </span>
            <span className="mk-choice__text">
              <span className="mk-choice__title">{ENGINE_LABELS[choice.id]}</span>
              <span className="mk-choice__description">{choice.description}</span>
            </span>
            <span className="mk-choice__status">
              {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Spinner size={12} />}
              <span className={cx('mk-choice__check', selected && 'mk-choice__check--on')} aria-hidden>
                <Check />
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** ST-60: the opt-in switch, the command to add Apex to Claude Code, its tabs and revoke. */
export function OutsideAccessCard({ status, settings, update }: PageProps & { status: EngineStatus | null }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const toast = useToast()
  const [adding, setAdding] = useState(false)
  const external = status?.external ?? null

  const copy = async (): Promise<void> => {
    try {
      await call('engine', 'copyCommand')
      toast.show({ tone: 'success', message: t('settings.modelAndKey.commandCopiedPasteIt') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }
  const add = async (): Promise<void> => {
    setAdding(true)
    try {
      const result = await call('engine', 'addToClaudeCode')
      toast.show({ tone: result.ok ? 'success' : 'error', message: result.message })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setAdding(false)
    }
  }
  const revoke = async (): Promise<void> => {
    const ok = await confirm({
      title: t('settings.modelAndKey.revokeAccessForClaude'),
      message: t('settings.modelAndKey.apexMakesANew'),
      confirmLabel: t('settings.modelAndKey.revoke'),
      destructive: true,
    })
    if (!ok) return
    try {
      await call('engine', 'revoke')
      toast.show({ tone: 'success', message: t('settings.modelAndKey.accessRevokedTheOld') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  return (
    <Card className="mk-card">
      <Switch
        label={t('settings.modelAndKey.letClaudeCodeUse2')}
        description={t('settings.modelAndKey.aClaudeCodeSession')}
        checked={settings.externalAccess}
        onChange={(externalAccess) => update({ externalAccess })}
      />
      {external?.problem && (
        <div className="mk-pad">
          <Notice tone="error">{external.problem}</Notice>
        </div>
      )}
      {settings.externalAccess && external?.enabled && (
        <>
          <Row title={t('settings.modelAndKey.addApexToClaude')} description={external.added ? t('settings.modelAndKey.addedNewClaudeCode') : t('settings.modelAndKey.runThisOnceIn')} stack>
            <div className="mk-command">
              <code className="mk-command__text">{external.command ?? t('settings.modelAndKey.startingApexSLocal')}</code>
              <div className="sp-field__row">
                <Button size="sm" variant="secondary" icon={<Copy />} disabled={!external.command} onClick={() => void copy()}>
                  {t('settings.modelAndKey.copyCommand')}
                </Button>
                <Button size="sm" variant={external.added ? 'ghost' : 'primary'} icon={external.added ? <Check /> : <SquareTerminal />} loading={adding} disabled={!external.command} onClick={() => void add()}>
                  {external.added ? t('settings.modelAndKey.addAgain') : t('settings.modelAndKey.addForMe')}
                </Button>
              </div>
            </div>
          </Row>
          <Row title={t('settings.modelAndKey.tabsItMayUse')} description={settings.externalTabs === 'own' ? t('settings.modelAndKey.onlyTabsItOpens') : t('settings.modelAndKey.anyOpenTabThat')}>
            <SegmentedControl
              label={t('settings.modelAndKey.tabsClaudeCodeMay')}
              size="sm"
              value={settings.externalTabs}
              options={[
                { value: 'own', label: t('settings.modelAndKey.tabsItOpens') },
                { value: 'any', label: t('settings.modelAndKey.anyTab') },
              ]}
              onChange={(externalTabs) => update({ externalTabs })}
            />
          </Row>
          <Row title={t('settings.modelAndKey.revokeAccess')} description={external.activeTabs > 0 ? `Working in ${external.activeTabs === 1 ? 'one tab' : `${external.activeTabs} tabs`} right now. Revoking stops it at once.` : t('settings.modelAndKey.makesANewSecret')}>
            <Button size="sm" variant="danger" icon={<Unplug />} onClick={() => void revoke()}>
              {t('settings.modelAndKey.revoke')}
            </Button>
          </Row>
          <p className="mk-foot">
            <ShieldCheck aria-hidden />
            <span>{t('settings.modelAndKey.itsTabsShowThe')}</span>
          </p>
        </>
      )}
    </Card>
  )
}

const FOLLOW = 'global'

export interface CompanionEngineChoice {
  /** False in builds with the API key as the only engine: show no engine row at all. */
  visible: boolean
  /** 'global' follows the default engine; otherwise an EngineId. */
  value: string
  options: Array<{ value: string; label: string }>
  onChange(value: string): void
}

/**
 * A companion's own engine (ST-58) for its profile's Models tab, as data for
 * whatever picker the tab draws: follow the default, or always one engine.
 * Saves on change.
 */
export function useCompanionEngine(companion: Pick<Companion, 'id' | 'engine'>): CompanionEngineChoice {
  const t = useT()
  const status = useEngineStatus()
  const toast = useToast()
  if (!status || !hasEngineChoice(status)) return { visible: false, value: FOLLOW, options: [], onChange: () => undefined }
  return {
    visible: true,
    value: companion.engine ?? FOLLOW,
    options: [
      { value: FOLLOW, label: t('settings.modelAndKey.yourDefault', { value: ENGINE_LABELS[status.engine] }) },
      ...status.engines.map((engine) => ({ value: engine, label: `${ENGINE_LABELS[engine]} · ${engineBadge(status, engine).label.toLowerCase()}` })),
    ],
    onChange: (value) => {
      const engine = value === FOLLOW ? null : (value as EngineId)
      call('companions', 'update', companion.id, { engine }).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
    },
  }
}

/** The same choice as a ready-made field in the card's form style. */
export function CompanionEngineField({ companion, id }: { companion: Pick<Companion, 'id' | 'name' | 'engine'>; id?: string }): ReactElement | null {
  const t = useT()
  const choice = useCompanionEngine(companion)
  if (!choice.visible) return null
  return (
    <div className="co-field">
      <label className="co-field__label" htmlFor={id}>{t('settings.modelAndKey.engine')}</label>
      <Select id={id} fullWidth value={choice.value} onChange={choice.onChange} options={choice.options} />
      <p className="co-hint">{t('settings.modelAndKey.newChatsWithRun', { name: companion.name })}</p>
    </div>
  )
}
