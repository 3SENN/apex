/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What Apex can do (ON-09): an auto-advancing carousel of Apex's
// own animated scenes: working in tabs, meetings, documents, research,
// routines and memory. Arrows and ←/→ move, the dots show the position and
// jump, hover or focus pauses it, and reduced motion shows static slides
// that only move when you ask. The companion stars in the scenes, and the
// tiles around it in its slot follow the slide.
import { useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from 'react'
import { AppWindow, Brain, ChevronLeft, ChevronRight, FileText, Mic, Repeat, Search } from 'lucide-react'
import { SHOWCASE_SLIDES, SHOWCASE_SLIDE_MS, showcaseReducer, type ShowcaseSlideId } from '@shared/onboarding'
import { profileIsEmpty } from '@shared/userProfile'
import { call } from '../../api'
import { ShowcaseScene } from '../../illustrations'
import { Button, IconButton } from '../../ui'
import { useMotion } from '../../ui/motion'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene } from './StepFrame'
import { useT, t } from '../../i18n/useT'

const SLIDES: Record<ShowcaseSlideId, { title: string; text: string }> = {
  tabs: { get title() { return t('firstRun.welcomeShowcase.worksInYourTabs') }, get text() { return t('firstRun.welcomeShowcase.itReadsPagesClicks') } },
  meetings: { get title() { return t('firstRun.welcomeShowcase.takesMeetingNotes') }, get text() { return t('firstRun.welcomeShowcase.transcribesOnThisMac') } },
  documents: { get title() { return t('firstRun.welcomeShowcase.makesDocuments') }, get text() { return t('firstRun.welcomeShowcase.outlinesDraftsAndRewrites') } },
  research: { get title() { return t('firstRun.welcomeShowcase.researchesProperly') }, get text() { return t('firstRun.welcomeShowcase.opensGoodSourcesCompares') } },
  routines: { get title() { return t('firstRun.welcomeShowcase.runsRoutines') }, get text() { return t('firstRun.welcomeShowcase.doesAJobOn') } },
  memory: { get title() { return t('firstRun.welcomeShowcase.remembersWhatYouLike') }, get text() { return t('firstRun.welcomeShowcase.keepsShortNotesYou') } },
}

const ICON: Record<ShowcaseSlideId, ReactElement> = { tabs: <AppWindow />, meetings: <Mic />, documents: <FileText />, research: <Search />, routines: <Repeat />, memory: <Brain /> }

const TICK_MS = 200
/** ON-18: the slides your profile is about (all of them without one); none skips the step. */
export function ShowcaseStep(props: StepProps): ReactElement | null {
  const [slides, setSlides] = useState<readonly ShowcaseSlideId[] | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all([call('onboarding', 'profile').catch(() => null), call('onboarding', 'plan').catch(() => null)]).then(([profile, plan]) => {
      if (!live) return
      const picked = profile && plan && !profileIsEmpty(profile) ? plan.showcase : SHOWCASE_SLIDES
      if (picked.length === 0) {
        props.ready()
        props.next()
      } else setSlides(picked)
    })
    return () => {
      live = false
    }
  }, [])
  return slides ? <ShowcaseSlides {...props} slides={slides} /> : null
}

function ShowcaseSlides({ next, back, ready, look, slides }: StepProps & { slides: readonly ShowcaseSlideId[] }): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const reduce = useMemo(() => showcaseReducer(slides.length), [slides.length])
  const [state, dispatch] = useReducer(reduce, { index: 0, paused: reduced, elapsed: 0 })
  const region = useRef<HTMLDivElement>(null)
  const hovering = useRef(false)
  const focused = useRef(false)

  useEffect(() => ready(), [])
  useEffect(() => dispatch({ type: 'pause', on: reduced || hovering.current || focused.current }), [reduced])
  useEffect(() => {
    if (reduced) return
    const timer = setInterval(() => dispatch({ type: 'tick', ms: TICK_MS }), TICK_MS)
    return () => clearInterval(timer)
  }, [reduced])
  const hold = (): void => dispatch({ type: 'pause', on: reduced || hovering.current || focused.current })

  const id = slides[state.index] ?? 'tabs'
  const slide = SLIDES[id]
  return (
    <StepFrame
      title={t('firstRun.welcomeShowcase.whatApexCanDo')}
      card="bare"
      back={<BackButton onBack={back} />}
      actions={<Button variant="primary" onClick={() => next()}>{t('firstRun.welcomeShowcase.continue')}</Button>}
    >
      <StepScene tiles={slides.map((s, i) => ({ id: s, icon: ICON[s], on: i === state.index, current: i === state.index }))} />
      <div
        ref={region}
        className="wlx__showcase"
        role="region"
        aria-roledescription="carousel"
        aria-label={t('firstRun.welcomeShowcase.whatApexCanDo')}
        tabIndex={0}
        onMouseEnter={() => {
          hovering.current = true
          hold()
        }}
        onMouseLeave={() => {
          hovering.current = false
          hold()
        }}
        onFocus={() => {
          focused.current = true
          hold()
        }}
        onBlur={(e) => {
          if (region.current?.contains(e.relatedTarget as Node | null)) return
          focused.current = false
          hold()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            dispatch({ type: 'next' })
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            dispatch({ type: 'prev' })
          }
        }}
      >
        <div className="wlx__slide" key={id} role="group" aria-roledescription="slide" aria-label={t('firstRun.welcomeShowcase.of', { value: state.index + 1, length: slides.length, title: slide.title })}>
          <ShowcaseScene id={id} animate={!reduced} look={look} />
          <h2>{slide.title}</h2>
          <p>{slide.text}</p>
        </div>
        <div className="wlx__showcase-nav">
          <IconButton label={t('firstRun.welcomeShowcase.previous')} icon={<ChevronLeft />} variant="subtle" onClick={() => dispatch({ type: 'prev' })} />
          <div className="wlx__progress-dots" role="tablist" aria-label={t('firstRun.welcomeShowcase.slides')}>
            {slides.map((s, i) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={i === state.index}
                aria-label={SLIDES[s].title}
                className="wlx__progress-dot"
                tabIndex={i === state.index ? 0 : -1}
                onClick={() => dispatch({ type: 'go', index: i })}
              >
                {i === state.index && !reduced && <span className="wlx__progress-fill" style={{ transform: `scaleX(${Math.min(1, state.elapsed / SHOWCASE_SLIDE_MS)})` }} />}
              </button>
            ))}
          </div>
          <IconButton label={t('firstRun.welcomeShowcase.next')} icon={<ChevronRight />} variant="subtle" onClick={() => dispatch({ type: 'next' })} />
        </div>
        <p className="ui-sr-only" aria-live="polite">{slide.title}</p>
      </div>
    </StepFrame>
  )
}
