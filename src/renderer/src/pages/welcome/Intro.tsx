/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The animated intro (ON-02, the "dawn"): the Apex logo (Pip's head) pops in with a spark, a
// horizon glow rises, the companion pops up through a floor ring and waves,
// then the welcome line. Light and dark staging come from the welcome's
// tokens; reduced motion skips straight to the line. Around the companion,
// four tiles for what it does (pages, forms, comparing, remembering). Enter continues. The
// intro sounds (NS-04) play on the beats unless they are off or motion is
// reduced.
import { useEffect, useRef, type Dispatch, type ReactElement, type SetStateAction } from 'react'
import { Globe, Heart, Scale, TextCursorInput } from 'lucide-react'
import { Button, Kbd } from '../../ui'
import { useMotion } from '../../ui/motion'
import type { WelcomeIntro } from '../welcomeLogic'
import { playIntroBeat } from './introSounds'
import { StepFrame, StepScene, type SceneTile } from './StepFrame'
import { useT } from '../../i18n/useT'
import { BrandMark } from '../../brand/BrandLogo'

export function IntroMark(): ReactElement {
  return (
    <div className="wl-dawn" aria-hidden="true">
      <div className="wl-dawn__mark">
        <BrandMark size={88} className="wl-dawn__pip" />
        <svg className="wl-dawn__spark" viewBox="0 0 24 24">
          <path d="M12 1.5 13.9 10.1 22.5 12 13.9 13.9 12 22.5 10.1 13.9 1.5 12 10.1 10.1Z" />
        </svg>
      </div>
    </div>
  )
}

/** Reads pages, fills forms, compares options, remembers what you like: the intro's own line, drawn. */
const INTRO_TILES: SceneTile[] = [
  { id: 'pages', icon: <Globe /> },
  { id: 'forms', icon: <TextCursorInput /> },
  { id: 'compare', icon: <Scale /> },
  { id: 'remember', icon: <Heart /> },
]

interface IntroProps {
  intro: WelcomeIntro
  setIntro: Dispatch<SetStateAction<WelcomeIntro>>
  introSounds: boolean
  onWave(): void
  onReady(): void
  onContinue(): void
}

export function Intro({ intro, setIntro, introSounds, onWave, onReady, onContinue }: IntroProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const sound = introSounds && !reduced
  const button = useRef<HTMLButtonElement>(null)

  // The dawn plays once; the companion waves as it pops up.
  useEffect(() => {
    onReady()
    if (intro.phase === 'done') {
      if (sound) playIntroBeat('welcome')
      onWave()
      return
    }
    if (sound) playIntroBeat('mark')
    const timers = [
      setTimeout(() => {
        setIntro((s) => ({ ...s, phase: 'rise' }))
        if (sound) playIntroBeat('rise')
      }, intro.markMs),
      setTimeout(() => {
        setIntro((s) => ({ ...s, phase: 'done' }))
        onWave()
        if (sound) playIntroBeat('welcome')
      }, intro.totalMs),
    ]
    return () => timers.forEach(clearTimeout)
  }, [])

  useEffect(() => {
    if (intro.phase === 'done') button.current?.focus({ preventScroll: true })
  }, [intro.phase])

  // Enter continues from anywhere on the page once the line is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName)) return
      e.preventDefault()
      if (intro.phase === 'done') onContinue()
      else setIntro((s) => ({ ...s, phase: 'done' }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [intro.phase])

  return (
    <>
      {intro.phase !== 'mark' && <StepScene tiles={INTRO_TILES} />}
      <StepFrame
        title={t('firstRun.welcomeIntro.meetApex')}
        subtitle={t('firstRun.welcomeIntro.aBrowserWithA')}
        actions={<Button ref={button} variant="brand" onClick={onContinue}>{t('firstRun.welcomeIntro.getStarted')}</Button>}
        after={
          <span className="wlx__hint" aria-hidden="true">
            {t('firstRun.welcomeIntro.orPress')} <Kbd keys={['Enter']} />
          </span>
        }
      />
    </>
  )
}
