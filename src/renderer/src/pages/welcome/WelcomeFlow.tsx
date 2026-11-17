/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The setup flow (ON-01): a fixed sequence of steps whose
// progress main saves after every step (userData/setup.json), so a restart
// resumes where you left off. Visited steps can be revisited from the dots;
// the rest can be skipped after a confirmation, and setup can start over
// with a new companion. A step that hasn't loaded after 45 s logs a warning
// and offers to continue. One live companion stays for the whole flow
// (DS-78) in the step template's own slot (stage.ts): its
// bubble above it and the step's illustration around it, never over the
// words, beside the step on wide pages and above it otherwise.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ArrowLeft, MoreHorizontal } from 'lucide-react'
import { DEFAULT_PROFILE, type CompanionProfile } from '@shared/companion'
import { SETUP_STEPS, STEP_WATCHDOG_MS, nextSetupStep, previousSetupStep, setupStepIndex, type SetupPatch, type SetupState, type SetupStepId } from '@shared/onboarding'
import type { SettingsView } from '@shared/ipc'
import { call, errorText, useAppEvent } from '../../api'
import { Bubble, Companion } from '../../companion'
import { useActiveCompanion, useCompanions } from '../../components/companionData'
import { ShapeField } from '../../companion-card/ShapeField'
import { Button, ErrorState, IconButton, Skeleton, confirm, showMenu, toast } from '../../ui'
import { useMotion } from '../../ui/motion'
import { welcomeIntro } from '../welcomeLogic'
import { AiImportStep } from './AiImport'
import { ConnectorsStep } from './Connectors'
import { Intro, IntroMark } from './Intro'
import { QuestionsStep } from './Questions'
import { ShowcaseStep } from './Showcase'
import { WorkspaceStep } from './Workspace'
import { BrowserImportStep, EngineStep, FavoritesStep, LaunchStep, LayoutStep, LookStep, NameStep } from './steps'
import { STEP_MOOD, STEP_TITLE, stepLine } from './logic'
import { StageContext } from './StepFrame'
import { SAY_H, cardRoom, welcomeSlot } from './stage'
import '../../companion-card/card.css'
import '../welcome.css'
import './setupFlow.css'
import { useT } from '../../i18n/useT'

export interface WelcomeProps {
  tabId: string
  /** Older callers pass the active profile; the flow reads the companion list itself. */
  companion?: CompanionProfile
  settings: SettingsView
  onSettings(view: SettingsView): void
  isMac: boolean
}

/** What every step gets from the shell. */
export interface StepProps {
  setup: SetupState
  settings: SettingsView
  onSettings(view: SettingsView): void
  isMac: boolean
  tabId: string
  /** The companion this setup is making (null until the name step creates or picks one). */
  companion: { id: string; name: string; look: CompanionProfile['look'] } | null
  /** Saves answers (and anything else) and moves on. */
  next(patch?: Omit<SetupPatch, 'step'>): void
  back(): void
  save(patch: SetupPatch): Promise<SetupState | null>
  /** The step has loaded; stops the watchdog. */
  ready(): void
  /** The look being made shows on the one figure. */
  preview(profile: CompanionProfile | null): void
  /** Back to the companion's line for the step (questions speak their own). */
  say(line: string | null): void
  /** The look on the figure now (the preview while one is being made), for the illustrations. */
  look: CompanionProfile['look']
}

/** The page's size, kept current, for the template's slot. */
function usePageBox(el: HTMLElement | null): { width: number; height: number } {
  const [box, setBox] = useState(() => ({ width: typeof window === 'undefined' ? 1280 : window.innerWidth, height: typeof window === 'undefined' ? 800 : window.innerHeight }))
  useLayoutEffect(() => {
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      setBox((b) => (Math.round(b.width) === Math.round(r.width) && Math.round(b.height) === Math.round(r.height) ? b : { width: r.width, height: r.height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return box
}

export function WelcomePage({ tabId, settings, onSettings, isMac }: WelcomeProps): ReactElement {
  const t = useT()
  const active = useActiveCompanion()
  const { items } = useCompanions()
  const { reduced } = useMotion()
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [direction, setDirection] = useState<1 | -1>(1)
  const [preview, setPreview] = useState<CompanionProfile | null>(null)
  const [line, setLine] = useState<string | null>(null)
  const [intro, setIntro] = useState(() => welcomeIntro(reduced))
  const [waves, setWaves] = useState(0)
  const [slow, setSlow] = useState(false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [deco, setDeco] = useState<HTMLDivElement | null>(null)
  const [cheer, setCheer] = useState(0)
  const readyRef = useRef(false)
  const step = setup?.step ?? 'intro'
  const box = usePageBox(root)
  const slot = welcomeSlot(box.width, box.height)

  const load = (): void => {
    setLoadError(null)
    call('onboarding', 'state').then(setSetup, (err: unknown) => setLoadError(errorText(err)))
  }
  useEffect(load, [])
  useAppEvent('onboarding', (e) => setSetup(e.state))

  // A notice from a reset setup file shows once.
  useEffect(() => {
    if (setup?.notice) toast.show({ message: setup.notice, tone: 'info' })
  }, [setup?.notice])

  // The watchdog (ON-01): a step that hasn't loaded in 45 s is logged and can be skipped past.
  useEffect(() => {
    readyRef.current = false
    setSlow(false)
    setLine(null)
    const timer = setTimeout(() => {
      if (readyRef.current) return
      void call('onboarding', 'stepTimeout', step).catch(() => undefined)
      setSlow(true)
    }, STEP_WATCHDOG_MS)
    return () => clearTimeout(timer)
  }, [step])

  // The last step celebrates once each time it is reached.
  useEffect(() => {
    if (step === 'launch' && !reduced) setCheer((n) => n + 1)
  }, [step])

  const save = async (patch: SetupPatch): Promise<SetupState | null> => {
    try {
      const next = await call('onboarding', 'save', patch)
      setSetup(next)
      return next
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      return null
    }
  }
  const go = (to: SetupStepId | null, patch: Omit<SetupPatch, 'step'> = {}): void => {
    if (!to) return
    setDirection(setupStepIndex(to) >= setupStepIndex(step) ? 1 : -1)
    void save({ ...patch, step: to })
  }
  const skipRest = async (): Promise<void> => {
    const ok = await confirm({ title: t('firstRun.welcomeFlow.skipTheRestOf'), message: t('firstRun.welcomeFlow.youCanChangeEverything'), confirmLabel: t('firstRun.welcomeFlow.skipToTheEnd') })
    if (!ok) return
    try {
      await call('onboarding', 'skipRest')
      setDirection(1)
      setSetup(await call('onboarding', 'state'))
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }
  const moreMenu = async (anchor: Element): Promise<void> => {
    const picked = await showMenu(
      [
        { id: 'skip', label: t('firstRun.welcomeFlow.skipTheRest'), enabled: step !== 'launch' },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'restart', label: t('firstRun.welcomeFlow.startOver') },
        { id: 'restart-new', label: t('firstRun.welcomeFlow.startOverWithA') },
      ],
      anchor,
    )
    if (picked === 'skip') return void skipRest()
    if (picked !== 'restart' && picked !== 'restart-new') return
    const fresh = picked === 'restart-new'
    const ok = await confirm({ title: fresh ? t('firstRun.welcomeFlow.startOverWithA2') : t('firstRun.welcomeFlow.startSetupOver'), message: fresh ? t('firstRun.welcomeFlow.yourCurrentCompanionStays') : t('firstRun.welcomeFlow.yourAnswersSoFar'), confirmLabel: t('firstRun.welcomeFlow.startOver') })
    if (!ok) return
    try {
      setDirection(-1)
      setSetup(await call('onboarding', 'restart', { newCompanion: fresh }))
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const made = setup?.companionId ? (items.find((c) => c.id === setup.companionId) ?? null) : null
  const shown: CompanionProfile = preview ?? made ?? active ?? DEFAULT_PROFILE
  const tint = shown.look.colors.accent
  const intoView = step !== 'intro' || intro.phase !== 'mark'
  const vars = {
    '--hero-tint': tint,
    '--wlt-scene-w': `${slot.sceneW}px`,
    '--wlt-scene-h': `${slot.sceneH}px`,
    '--wlt-figure': `${slot.figure}px`,
    '--wlt-tile': `${slot.tile}px`,
    '--wlt-say-h': `${SAY_H}px`,
    // About what the content card gets on this page (a one-line title, two-line subtitle): pictures in it size to fit.
    '--wlt-card-room': `${Math.max(120, cardRoom(slot, box.height, 88, 40))}px`,
  } as CSSProperties

  if (!setup) {
    return (
      <div ref={setRoot} className="welcome wl wlx" data-intro="done" data-slot={slot.mode} style={vars}>
        <div className="wlx__loading">
          {loadError ? <ErrorState title={t('firstRun.welcomeFlow.setupCouldnTStart')} message={loadError} onRetry={load} /> : <Skeleton width={320} height={180} />}
        </div>
      </div>
    )
  }

  const props: StepProps = {
    setup,
    settings,
    onSettings,
    isMac,
    tabId,
    companion: made ? { id: made.id, name: made.name, look: made.look } : null,
    next: (patch = {}) => go(nextSetupStep(step), patch),
    back: () => go(previousSetupStep(step)),
    save,
    ready: () => {
      readyRef.current = true
      setSlow(false)
    },
    preview: setPreview,
    say: setLine,
    look: shown.look,
  }
  const index = setupStepIndex(step)

  return (
    <div ref={setRoot} className="welcome wl wlx" data-intro={step === 'intro' ? intro.phase : 'done'} data-step-id={step} data-slot={slot.mode} style={vars}>
      <div className="wl__backdrop" aria-hidden="true">
        <span className="wl__wash" />
        <span className="wl__horizon" />
      </div>

      <div className="wlx__bar">
        <ol className="wlx__dots" aria-label={t('firstRun.welcomeFlow.stepOf', { value: index + 1, length: SETUP_STEPS.length, value2: STEP_TITLE[step] })}>
          {SETUP_STEPS.map((id, i) => {
            const visited = setup.visited.includes(id)
            return (
              <li key={id}>
                <button
                  type="button"
                  className="wlx__dot"
                  data-active={id === step || undefined}
                  data-visited={visited || undefined}
                  disabled={!visited || id === step}
                  aria-current={id === step ? 'step' : undefined}
                  aria-label={`${STEP_TITLE[id]}${visited ? '' : t('firstRun.welcomeFlow.notReachedYet')}`}
                  title={STEP_TITLE[id]}
                  onClick={() => go(id)}
                />
                <span className="ui-sr-only">{i + 1}</span>
              </li>
            )
          })}
        </ol>
        <IconButton className="wlx__menu" label={t('firstRun.welcomeFlow.setupOptions')} icon={<MoreHorizontal />} variant="subtle" onClick={(e) => void moreMenu(e.currentTarget)} />
      </div>

      <StageContext.Provider value={{ target: deco, slot }}>
        <div className="wlt">
          {/* The companion's slot: its bubble on its own row, the figure and the step's illustration below. */}
          <div className="wlt__stage">
            <div className="wlt__say">
              {intoView && <Bubble text={line ?? stepLine(step, shown.name)} side="center" tint={tint} revealKey={`${step}/${shown.name}/${line ?? ''}`} announce />}
            </div>
            <div className="wlt__scene" aria-hidden="true">
              <div className="wlt__halo" data-in={intoView ? 'true' : undefined}>
                <ShapeField tint={tint} density="card" className="wlt__sparkle" origin={{ x: 0.5, y: 0.78 }} pulse={waves + cheer} paused={intro.phase === 'mark'} still={reduced} />
              </div>
              <div className="wlt__deco" ref={setDeco} />
              <div className="wl__figure wlt__figure" data-in={intoView ? 'true' : undefined}>
                <span className="wl__ring" data-on={step === 'intro' && intro.phase === 'rise' ? 'true' : undefined} />
                <Companion profile={shown} mood={STEP_MOOD[step]} size="fill" framing="full" greet={waves > 0} celebrate={cheer} priority={2} />
              </div>
              {step === 'intro' && intro.phase !== 'done' && <IntroMark />}
            </div>
          </div>

          <div className="wlt__body" key={step} data-dir={direction > 0 ? 'next' : 'back'} data-in={intoView ? 'true' : undefined}>
            {slow && (
              <div className="wlx__slow" role="alert">
                <p>{t('firstRun.welcomeFlow.thisStepIsTaking')}</p>
                <Button variant="secondary" onClick={() => props.next()}>{t('firstRun.welcomeFlow.continueAnyway')}</Button>
              </div>
            )}
            {step === 'intro' && (
              <Intro
                intro={intro}
                setIntro={setIntro}
                introSounds={settings.introSounds !== false}
                onWave={() => setWaves((n) => n + 1)}
                onReady={props.ready}
                onContinue={() => props.next()}
              />
            )}
            {step === 'name' && <NameStep {...props} />}
            {step === 'look' && <LookStep {...props} />}
            {step === 'engine' && <EngineStep {...props} />}
            {step === 'layout' && <LayoutStep {...props} />}
            {step === 'questions' && <QuestionsStep {...props} />}
            {step === 'workspace' && <WorkspaceStep {...props} />}
            {step === 'connectors' && <ConnectorsStep {...props} />}
            {step === 'import-browser' && <BrowserImportStep {...props} />}
            {step === 'import-ai' && <AiImportStep {...props} />}
            {step === 'showcase' && <ShowcaseStep {...props} />}
            {step === 'favorites' && <FavoritesStep {...props} />}
            {step === 'launch' && <LaunchStep {...props} />}
          </div>
        </div>
      </StageContext.Provider>
    </div>
  )
}

/** The Back button every step after the intro shows. */
export function BackButton({ onBack }: { onBack(): void }): ReactElement {
  const t = useT()
  return (
    <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack}>
      {t('firstRun.welcomeFlow.back')}
    </Button>
  )
}
