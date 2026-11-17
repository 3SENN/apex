/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The preset companion gallery (apex://presets) and a preset's
// profile (apex://presets/<id>). The gallery is a three-column grid of cards,
// each washed in the preset's own colour with its figure standing in it, the
// name, a description, an add pill and a profile link. The profile has a
// sticky card on the left (figure, add pill, the apps it can work in) and
// cards on the right: stat tiles, its skills, its routines and its
// personality. Each skill and routine opens its own detail view
// (PresetItemSheet). Adding works as in the detail sheet (presetAdd.ts).
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { ArrowLeft, CalendarClock, Check, Globe, MessageSquarePlus, Plug, Plus, UserRound, WandSparkles } from 'lucide-react'
import type { CompanionPreset } from '@shared/companion'
import type { MessageKey } from '@shared/i18n/en'
import type { PresetDetail } from '@shared/onboarding'
import { companionUrl, presetUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { scheduleText } from '../chat/cards/AgentToolCards'
import { Companion as CompanionFigure } from '../companion'
import { PresetReview } from '../companion-card/PresetReview'
import { ShapeField } from '../companion-card/ShapeField'
import { companionFromPreset, presetStats, routineSkill, usePresetAdd, type PresetStatId } from '../companion-card/presetAdd'
import { useCompanions, usePresets } from '../components/companionData'
import { ConnectorLogo } from '../connectors/ConnectorLogo'
import { useConnectorList } from '../connectors/status'
import { useT } from '../i18n/useT'
import { Button, EmptyState, ErrorState, Skeleton, SkeletonRows, cx } from '../ui'
import { PresetItemSheet } from './PresetItemSheet' // The detail views
import type { PresetItemRef } from '../companion-card/logic/presetProfile'
import '../guidance/presetGallery.css'

export interface PresetsPageProps {
  tabId: string
  presetId: string | null
}

/** How long an empty preset list counts as still loading (the assets may be generating). */
const EMPTY_GRACE_MS = 2500

const STAT_LABELS: Record<PresetStatId, MessageKey> = {
  skills: 'galleries.presets.stat.skills',
  routines: 'galleries.presets.stat.routines',
  yours: 'galleries.presets.stat.yours',
  version: 'galleries.presets.stat.version',
}

const tintStyle = (preset: CompanionPreset): CSSProperties => ({ '--ps-tint': preset.look.colors.accent }) as CSSProperties

export default function PresetsPage({ tabId, presetId }: PresetsPageProps): ReactElement {
  const td = useT()
  const presets = usePresets()
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), EMPTY_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])
  const go = (id: string | null): void => void apex.nav.go(tabId, presetUrl(id))

  if (presets.length === 0) {
    return (
      <PresetsFrame label={td('galleries.presets.title')}>
        {waited ? <EmptyState title={td('galleries.presets.empty')} description={td('galleries.presets.empty.description')} /> : <SkeletonRows rows={3} label={td('galleries.presets.loading')} />}
      </PresetsFrame>
    )
  }
  if (presetId) {
    const preset = presets.find((p) => p.id === presetId)
    return preset ? (
      <PresetProfile key={preset.id} preset={preset} onBack={() => go(null)} />
    ) : (
      <PresetsFrame label={td('galleries.presets.title')}>
        <EmptyState title={td('galleries.presets.missing')} description={td('galleries.presets.missing.description')} action={<Button variant="secondary" onClick={() => go(null)}>{td('galleries.presets.all')}</Button>} />
      </PresetsFrame>
    )
  }
  return <PresetGallery presets={presets} onProfile={(id) => go(id)} />
}

function PresetsFrame({ label, children }: { label: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <div className="sp-page">
      <main className="sp-main" aria-label={label}>
        <div className="ps-content">{children}</div>
      </main>
    </div>
  )
}

// ---- the gallery ----

function PresetGallery({ presets, onProfile }: { presets: CompanionPreset[]; onProfile(id: string): void }): ReactElement {
  const td = useT()
  return (
    <PresetsFrame label={td('galleries.presets.title')}>
      <header className="ps-head">
        <h1>{td('galleries.presets.title')}</h1>
        <p>{td('galleries.presets.intro')}</p>
      </header>
      <ul className="ps-grid" aria-label={td('galleries.presets.title')}>
        {presets.map((p, i) => (
          <PresetCard key={p.id} preset={p} index={i} onProfile={() => onProfile(p.id)} />
        ))}
      </ul>
    </PresetsFrame>
  )
}

function PresetCard({ preset, index, onProfile }: { preset: CompanionPreset; index: number; onProfile(): void }): ReactElement {
  const td = useT()
  const { items } = useCompanions()
  const owned = companionFromPreset(items, preset.id)
  const flow = usePresetAdd()
  const added = flow.state.kind === 'added' ? flow.state.companion : null
  const add = async (): Promise<void> => {
    try {
      await flow.add(await call('companions', 'presetDetail', preset.id))
    } catch {
      // presetDetail failed: the profile shows why; the card stays as it was.
    }
  }
  const nameId = `ps-card-${preset.id}`
  return (
    <li className="ps-card" style={{ ...tintStyle(preset), '--ps-order': index } as CSSProperties} aria-labelledby={nameId}>
      <div className="ps-card__wash" aria-hidden>
        <CompanionFigure profile={{ name: preset.name, persona: preset.id, look: preset.look, dockIcon: false }} mood="happy" size={132} greet={added !== null} />
      </div>
      <div className="ps-card__body">
        <button type="button" id={nameId} className="ps-card__name" onClick={onProfile}>
          {preset.name}
        </button>
        <p className="ps-card__desc">{preset.tagline}</p>
        {flow.state.kind === 'preparing' && (
          <p className="ps-note" role="status">
            {td('galleries.presets.preparing', { name: preset.name })}
          </p>
        )}
        {flow.state.kind === 'failed' && (
          <p className="ps-note ps-note--error" role="alert">
            {flow.state.message}
          </p>
        )}
        <div className="ps-card__actions">
          {added ? (
            <Button variant="primary" className="ps-pill" icon={<MessageSquarePlus />} onClick={() => void flow.startChat(added)}>
              {td('galleries.presets.startChat')}
            </Button>
          ) : owned ? (
            <Button variant="secondary" className="ps-pill" icon={<Check />} onClick={() => void call('pages', 'open', companionUrl(owned.id, 'general'))}>
              {td('galleries.presets.open')}
            </Button>
          ) : (
            <Button variant="primary" className="ps-pill" icon={<Plus />} loading={flow.state.kind === 'preparing'} onClick={() => void add()} aria-label={td('galleries.presets.addNamed', { name: preset.name })}>
              {flow.state.kind === 'failed' ? td('galleries.presets.retry') : td('galleries.presets.add')}
            </Button>
          )}
          <button type="button" className="ps-link" onClick={onProfile} aria-label={td('galleries.presets.profileNamed', { name: preset.name })}>
            {td('galleries.presets.profile')}
          </button>
        </div>
      </div>
    </li>
  )
}

// ---- the profile ----

function PresetProfile({ preset, onBack }: { preset: CompanionPreset; onBack(): void }): ReactElement {
  const td = useT()
  const { items } = useCompanions()
  const [detail, setDetail] = useState<PresetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  // The starter skill or routine whose detail view is open.
  const [item, setItem] = useState<PresetItemRef | null>(null)
  const flow = usePresetAdd()
  const connectors = useConnectorList()
  const load = (): void => {
    setError(null)
    call('companions', 'presetDetail', preset.id).then(setDetail, (err: unknown) => setError(errorText(err)))
  }
  useEffect(load, [preset.id])

  const owned = companionFromPreset(items, preset.id)
  const added = flow.state.kind === 'added' ? flow.state.companion : null
  const apps = (connectors ?? []).filter((c) => c.enabled)

  const action = added ? (
    <Button variant="primary" className="ps-side__pill" icon={<MessageSquarePlus />} onClick={() => void flow.startChat(added)}>
      {td('galleries.presets.startChat')}
    </Button>
  ) : owned ? (
    <Button variant="primary" className="ps-side__pill" icon={<UserRound />} onClick={() => void call('pages', 'open', companionUrl(owned.id, 'general'))}>
      {td('galleries.presets.open')}
    </Button>
  ) : (
    <Button variant="primary" className="ps-side__pill" icon={<Plus />} disabled={!detail} loading={flow.state.kind === 'preparing'} onClick={() => detail && void flow.add(detail)}>
      {flow.state.kind === 'failed' ? td('galleries.presets.retry') : td('galleries.presets.addNamed', { name: preset.name })}
    </Button>
  )

  return (
    <PresetsFrame label={preset.name}>
      <Button variant="ghost" className="ps-back" icon={<ArrowLeft />} onClick={onBack}>
        {td('galleries.presets.all')}
      </Button>
      <div className="ps-profile" style={tintStyle(preset)}>
        <aside className="ps-side" aria-labelledby="ps-side-name">
          <div className="ps-side__wash">
            <ShapeField tint={preset.look.colors.accent} density="card" className="ps-side__field" still />
            <CompanionFigure profile={{ name: preset.name, persona: preset.id, look: preset.look, dockIcon: false }} mood="happy" size={150} greet={added !== null} />
          </div>
          <p className="ps-side__by">{td('galleries.presets.by')}</p>
          <h1 id="ps-side-name" className="ps-side__name">
            {preset.name}
          </h1>
          <p className="ps-side__desc">{preset.tagline}</p>
          {action}
          {flow.state.kind === 'preparing' && (
            <p className="ps-note" role="status">
              {td('galleries.presets.preparing', { name: preset.name })}
            </p>
          )}
          {flow.state.kind === 'failed' && (
            <p className="ps-note ps-note--error" role="alert">
              {flow.state.message}
            </p>
          )}
          <hr className="ps-side__rule" />
          <h2 className="ps-side__label">{td('galleries.presets.worksWith')}</h2>
          <ul className="ps-chips">
            {apps.map((c) => (
              <li key={c.id} className="ps-chip">
                <ConnectorLogo name={c.name} logo={c.logo} size="sm" />
                {c.name}
              </li>
            ))}
            <li className="ps-chip">
              <Globe aria-hidden />
              {td('galleries.presets.anySite')}
            </li>
            {connectors !== null && apps.length === 0 && (
              <li>
                <button type="button" className="ps-chip ps-chip--action" onClick={() => void call('pages', 'open', 'apex://connectors')}>
                  <Plug aria-hidden />
                  {td('galleries.presets.connect')}
                </button>
              </li>
            )}
          </ul>
        </aside>

        <div className="ps-cards">
          {error ? (
            <ErrorState title={td('galleries.presets.loadFailed')} message={error} onRetry={load} />
          ) : !detail ? (
            <Skeleton height={240} />
          ) : (
            <>
              <section className="ps-panel" aria-labelledby="ps-glance">
                <h2 id="ps-glance" className="ps-panel__title">
                  {td('galleries.presets.glance')}
                </h2>
                <ul className="ps-stats">
                  {presetStats(detail, items).map((s) => (
                    <li key={s.id} className={cx('ps-stat', `ps-stat--${s.id}`)}>
                      <span className="ps-stat__value">{s.value}</span>
                      <span className="ps-stat__label">{td(STAT_LABELS[s.id])}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="ps-panel" aria-labelledby="ps-skills">
                <h2 id="ps-skills" className="ps-panel__title">
                  {td('galleries.presets.skills')}
                </h2>
                <p className="ps-panel__note">{td('galleries.presets.skills.note', { name: preset.name })}</p>
                {detail.starterSkills.length === 0 ? (
                  <p className="ps-panel__empty">{td('galleries.presets.skills.none')}</p>
                ) : (
                  <ul className="ps-skills">
                    {detail.starterSkills.map((s, i) => (
                      <li key={s.name} className="ps-skill ps-item-row" style={{ '--ps-hue': i } as CSSProperties}>
                        <button type="button" className="ps-item-row__open" aria-haspopup="dialog" aria-label={td('galleries.presets.item.open', { name: `/${s.name}` })} onClick={() => setItem({ kind: 'skill', name: s.name })} />
                        <span className="ps-skill__tile" aria-hidden>
                          <WandSparkles />
                        </span>
                        <span className="ps-skill__text">
                          <span className="ps-skill__name">/{s.name}</span>
                          <span className="ps-skill__desc">{s.description}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {detail.starterRoutines.length > 0 && (
                <section className="ps-panel" aria-labelledby="ps-routines">
                  <h2 id="ps-routines" className="ps-panel__title">
                    {td('galleries.presets.routines')}
                  </h2>
                  <p className="ps-panel__note">{td('galleries.presets.routines.note')}</p>
                  <ul className="ps-routines">
                    {detail.starterRoutines.map((r) => {
                      const skill = routineSkill(r.prompt)
                      return (
                        <li key={r.name} className="ps-routine ps-item-row">
                          <button type="button" className="ps-item-row__open" aria-haspopup="dialog" aria-label={td('galleries.presets.item.open', { name: r.name })} onClick={() => setItem({ kind: 'routine', name: r.name })} />
                          <span className="ps-routine__tile" aria-hidden>
                            <CalendarClock />
                          </span>
                          <span className="ps-routine__text">
                            <span className="ps-routine__name">{r.name}</span>
                            <span className="ps-routine__when">{scheduleText(r.schedule, td)}</span>
                          </span>
                          {skill && <span className="ps-routine__skill">/{skill}</span>}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              <section className="ps-panel" aria-labelledby="ps-about">
                <h2 id="ps-about" className="ps-panel__title">
                  {td('galleries.presets.about')}
                </h2>
                {detail.summary && <p className="ps-panel__text">{detail.summary}</p>}
                {preset.personality && preset.personality !== detail.summary && (
                  <>
                    <button type="button" className="sp-link" aria-expanded={full} aria-controls="ps-personality" onClick={() => setFull((v) => !v)}>
                      {full ? td('galleries.presets.personality.hide') : td('galleries.presets.personality.show')}
                    </button>
                    {full && (
                      <p id="ps-personality" className="ps-panel__text ps-panel__text--muted">
                        {preset.personality}
                      </p>
                    )}
                  </>
                )}
              </section>
              {owned && !added && <PresetReview companionId={owned.id} />}
              <PresetItemSheet detail={detail} presetName={preset.name} open={item} onOpen={setItem} />
            </>
          )}
        </div>
      </div>
    </PresetsFrame>
  )
}
