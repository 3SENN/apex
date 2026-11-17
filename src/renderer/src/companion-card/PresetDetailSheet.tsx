/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A preset's detail sheet (CO-17): the live look, its
// tagline, a personality summary with the full text behind a toggle, and its
// starter skills and routines. Add shows a short preparing state (the typing
// clip, CO-16), then the button becomes Start a chat; a preset you already
// added offers Open companion, and a review when the preset was updated.
import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { CalendarClock, MessageSquarePlus, UserRound, WandSparkles } from 'lucide-react'
import type { Companion, CompanionPreset } from '@shared/companion'
import type { PresetDetail } from '@shared/onboarding'
import { companionUrl, presetUrl } from '@shared/url'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { companionFromPreset, usePresetAdd } from './presetAdd'
import { Companion as CompanionFigure } from '../companion'
import { useCompanionClip } from '../companion/clips'
import { useCompanions, usePresets } from '../components/companionData'
import { Button, ErrorState, Sheet, Skeleton } from '../ui'
import { useMotion } from '../ui/motion'
import { PresetReview } from './PresetReview'
import { ShapeField } from './ShapeField'
import '../guidance/presets.css'

export interface PresetDetailSheetProps {
  presetId: string
  onClose(): void
  /** Called once the preset was added as a companion. */
  onAdded?(companion: Companion): void
}

export function PresetDetailSheet({ presetId, onClose, onAdded }: PresetDetailSheetProps): ReactElement {
  const td = useT()
  const presets = usePresets()
  const { items } = useCompanions()
  const [detail, setDetail] = useState<PresetDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  // The add flow is shared with the preset gallery and profile (presetAdd.ts).
  const flow = usePresetAdd(onAdded)
  const add = flow.state
  const preset: CompanionPreset | undefined = presets.find((p) => p.id === presetId)
  const existing = useMemo(() => companionFromPreset(items, presetId), [items, presetId])

  const load = (): void => {
    setError(null)
    call('companions', 'presetDetail', presetId).then(setDetail, (err: unknown) => setError(errorText(err)))
  }
  useEffect(load, [presetId])

  const addPreset = async (): Promise<void> => {
    if (detail) await flow.add(detail)
  }
  const startChat = async (companion: Companion): Promise<void> => {
    if (await flow.startChat(companion)) onClose()
  }
  const openProfile = (): void => void call('pages', 'open', presetUrl(presetId)).then(onClose)

  const added = add.kind === 'added' ? add.companion : null
  const owned = added ?? existing
  const footer = !detail ? null : added ? (
    <Button variant="brand" icon={<MessageSquarePlus />} onClick={() => void startChat(added)}>{td('galleries.presets.startChat')}</Button>
  ) : existing ? (
    <Button variant="primary" icon={<UserRound />} onClick={() => void call('pages', 'open', companionUrl(existing.id, 'general')).then(onClose)}>{td('galleries.presets.open')}</Button>
  ) : (
    <Button variant="brand" loading={add.kind === 'preparing'} onClick={() => void addPreset()}>{add.kind === 'failed' ? td('galleries.presets.retry') : td('galleries.presets.addNamed', { name: detail.name })}</Button>
  )

  return (
    <Sheet open onClose={onClose} title={detail?.name ?? preset?.name ?? td('galleries.presets.fallbackTitle')} description={detail?.tagline ?? preset?.tagline} footer={footer} size="md">
      {error ? (
        <ErrorState title={td('galleries.presets.loadFailed')} message={error} onRetry={load} />
      ) : !detail || !preset ? (
        <Skeleton height={220} />
      ) : (
        <div className="co-preset-detail">
          <div className="co-preset-detail__hero" style={{ '--hero-tint': preset.look.colors.accent } as CSSProperties}>
            <ShapeField tint={preset.look.colors.accent} density="card" className="co-preset-detail__field" />
            {add.kind === 'preparing' ? <Preparing preset={preset} /> : <CompanionFigure profile={{ name: preset.name, persona: preset.id, look: preset.look, dockIcon: false }} mood="happy" size={170} greet={add.kind === 'added'} />}
          </div>
          {add.kind === 'preparing' && <p className="co-hint" role="status">{td('galleries.presets.preparing', { name: detail.name })}</p>}
          {add.kind === 'failed' && <p className="co-field__error" role="alert">{add.message}</p>}
          {detail.summary && <p className="co-preset-detail__summary">{detail.summary}</p>}
          {preset.personality && preset.personality !== detail.summary && (
            <div>
              <button type="button" className="sp-link" aria-expanded={full} onClick={() => setFull((v) => !v)}>
                {full ? td('galleries.presets.personality.hide') : td('galleries.presets.personality.show')}
              </button>
              {full && <p className="co-preset-detail__personality">{preset.personality}</p>}
            </div>
          )}
          {(detail.starterSkills.length > 0 || detail.starterRoutines.length > 0) && (
            <section aria-labelledby="co-preset-starters">
              <h3 id="co-preset-starters" className="co-field__label">{td('galleries.presets.comesWith')}</h3>
              <ul className="co-preset-detail__starters">
                {detail.starterSkills.map((s) => (
                  <li key={`s-${s.name}`}>
                    <WandSparkles aria-hidden /> <span className="sp-mono">/{s.name}</span> <span className="co-hint">{s.description}</span>
                  </li>
                ))}
                {detail.starterRoutines.map((r) => (
                  <li key={`r-${r.name}`}>
                    <CalendarClock aria-hidden /> {r.name} <span className="co-hint">{td('galleries.presets.routinePaused')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {owned && !added && <PresetReview companionId={owned.id} />}
          {/* The preset's full profile page. */}
          <button type="button" className="sp-link co-preset-detail__profile" onClick={openProfile}>
            {td('galleries.presets.seeProfile')}
          </button>
        </div>
      )}
    </Sheet>
  )
}

function Preparing({ preset }: { preset: CompanionPreset }): ReactElement {
  const { reduced } = useMotion()
  const src = useCompanionClip(preset.look, 'typing', 192, { loop: true, reduced })
  return src ? <img className="co-preset-detail__clip" src={src} alt="" width={170} height={170} /> : <span className="co-preset-detail__clip" aria-hidden="true" />
}
