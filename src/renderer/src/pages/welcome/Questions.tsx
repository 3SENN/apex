/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Setup questions (ON-06, ON-18): a conversation with the companion when an
// engine can run it (Interview.tsx), else these cards. The cards (ON-06): the companion asks one card at a time: free text
// (typed or dictated through the mic), single or multiple choice with Other,
// confirm-or-correct, information and tool chips. Any card can be skipped,
// the connector card connects inline, and a short thinking pause with tips
// follows each answer. Answers are saved as you go, become your profile at
// the end (main writes its editable About me note), and seed the first chat. Nothing about you
// is looked up in the background. Around the companion, a tile per
// question lights up as it is answered.
import { useEffect, useId, useReducer, useRef, useState, type ReactElement } from 'react'
import { Briefcase, Check, Clock, Compass, Gauge, MessageSquareText, Mic, ShieldCheck, Square, User, WandSparkles } from 'lucide-react'
import { SETUP_QUESTIONS, initialQuestions, questionAnswered, questionsReducer, type QuestionsState, type SetupQuestion, type SetupState } from '@shared/onboarding'
import type { InterviewTurn } from '@shared/userProfile'
import { call, errorText } from '../../api'
import { useDictation } from '../../chat/dictation/useDictation'
import { TipsCarousel } from '../../guidance/TipsCarousel'
import { Button, Spinner } from '../../ui'
import { useMotion } from '../../ui/motion'
import { InlineConnectors } from './Connectors'
import { InterviewStep } from './Interview'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene, type SceneTile } from './StepFrame'
import { useT, t } from '../../i18n/useT'

const reduce = questionsReducer(SETUP_QUESTIONS)

/** The questions the scene draws, one tile each. */
const QUESTION_ICON: Record<string, ReactElement> = {
  'call-you': <User />,
  'time-zone': <Clock />,
  'use-cases': <Compass />,
  'reply-style': <MessageSquareText />,
  'hands-on': <Gauge />,
  work: <Briefcase />,
  'first-tool': <WandSparkles />,
}

function questionTiles(state: QuestionsState): SceneTile[] {
  const current = SETUP_QUESTIONS[state.index]?.id
  return Object.entries(QUESTION_ICON).map(([id, icon]) => {
    const answered = state.answers[id] !== undefined && state.answers[id] !== ''
    return { id, icon, on: answered, current: id === current, badge: answered ? 'check' : undefined }
  })
}
const THINK_MS = 700

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || t('firstRun.welcomeQuestions.yourTimeZone')
  } catch {
    return t('firstRun.welcomeQuestions.yourTimeZone')
  }
}

/** Setup already on the cards (a resumed setup): it stays on them. */
function cardsStarted(setup: SetupState): boolean {
  return SETUP_QUESTIONS.some((q) => q.kind !== 'info' && setup.answers[q.id] !== undefined)
}

/** A conversation when an engine can run one, else the question cards. */
export function QuestionsStep(props: StepProps): ReactElement {
  const t = useT()
  const [mode, setMode] = useState<{ kind: 'checking' } | { kind: 'chat'; first: InterviewTurn } | { kind: 'cards' }>(() => (cardsStarted(props.setup) ? { kind: 'cards' } : { kind: 'checking' }))
  useEffect(() => {
    props.ready()
    if (mode.kind !== 'checking') return
    let live = true
    call('onboarding', 'interviewTurn', []).then(
      (first) => live && setMode(first ? { kind: 'chat', first } : { kind: 'cards' }),
      () => live && setMode({ kind: 'cards' }),
    )
    return () => {
      live = false
    }
  }, [])
  if (mode.kind === 'chat') return <InterviewStep {...props} first={mode.first} />
  if (mode.kind === 'cards') return <QuestionCards {...props} />
  return (
    <>
      <StepScene tiles={[]} />
      <StepFrame title={t('firstRun.interview.starting')} busy actions={null}>
        <div className="wlx__thinking" role="status">
          <span className="wlx__dots-think" aria-hidden="true"><i /><i /><i /></span>
          <span className="ui-sr-only">{t('firstRun.interview.starting')}</span>
        </div>
      </StepFrame>
    </>
  )
}

function QuestionCards({ setup, next, back, save, ready, say }: StepProps): ReactElement {
  const t = useT()
  const { reduced } = useMotion()
  const [state, dispatch] = useReducer(reduce, setup.answers, (answers) => initialQuestions(answers))
  const [writing, setWriting] = useState<'idle' | 'writing' | 'done' | 'failed'>('idle')
  const [noteError, setNoteError] = useState<string | null>(null)
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const q: SetupQuestion | undefined = SETUP_QUESTIONS[state.index]
  const finished = state.index >= SETUP_QUESTIONS.length

  useEffect(() => {
    ready()
    return () => {
      if (thinkTimer.current) clearTimeout(thinkTimer.current)
    }
  }, [])
  useEffect(() => say(state.thinking ? t('firstRun.welcomeQuestions.hmmLetMeThink') : finished ? t('firstRun.welcomeQuestions.thanksIVeNoted') : (q?.prompt ?? null)), [state.index, state.thinking, finished])

  // Each answer is saved as you go, so a restart resumes at the next card.
  const persist = (s: QuestionsState, id: string): void => {
    const value = s.answers[id]
    if (value !== undefined) void save({ answers: { [id]: value } })
  }
  const advance = (kind: 'next' | 'skip'): void => {
    if (!q) return
    const after = reduce(state, { type: kind })
    persist(after, q.id)
    dispatch({ type: kind })
    // A short thinking pause after a real answer; never any lookup.
    if (kind === 'next' && q.kind !== 'info' && !reduced) {
      dispatch({ type: 'thinking', on: true })
      thinkTimer.current = setTimeout(() => dispatch({ type: 'thinking', on: false }), THINK_MS)
    }
  }

  // Your profile from the answers (main writes its About me note), for the workspace step.
  const writeNote = async (): Promise<void> => {
    setWriting('writing')
    setNoteError(null)
    try {
      await call('onboarding', 'finishInterview', null)
      setWriting('done')
    } catch (err) {
      setNoteError(errorText(err))
      setWriting('failed')
    }
  }
  useEffect(() => {
    if (finished && writing === 'idle') void writeNote()
  }, [finished])

  const scene = <StepScene tiles={questionTiles(state)} />
  if (finished) {
    return (
      <>
      {scene}
      <StepFrame
        title={t('firstRun.welcomeQuestions.thanksThatHelps')}
        subtitle={writing === 'done' ? t('firstRun.welcomeQuestions.yourAnswersAreIn') : undefined}
        back={<Button variant="ghost" onClick={() => dispatch({ type: 'jump', index: SETUP_QUESTIONS.length - 1 })}>{t('firstRun.welcomeQuestions.backToTheQuestions')}</Button>}
        actions={<Button variant="primary" disabled={writing === 'writing'} onClick={() => next()}>{t('firstRun.welcomeQuestions.continue')}</Button>}
      >
        {writing === 'writing' && (
          <div className="wlx__thinking" role="status">
            <Spinner size={16} /> {t('firstRun.welcomeQuestions.savingYourAnswers')}
            <TipsCarousel />
          </div>
        )}
        {writing === 'failed' && (
          <div className="wlx__slow" role="alert">
            <p>{t('firstRun.welcomeQuestions.theMemoryNoteCouldn', { noteError: noteError ?? '' })}</p>
            <Button variant="secondary" onClick={() => void writeNote()}>{t('firstRun.welcomeQuestions.tryAgain')}</Button>
          </div>
        )}
      </StepFrame>
      </>
    )
  }
  if (!q) return <></>

  // The opening note's hint sits in its card as a promise; other cards keep it under the question.
  const info = q.kind === 'info' && !state.thinking
  return (
    <>
      {scene}
      <StepFrame
        eyebrow={t('firstRun.welcomeQuestions.questionOf', { value: state.index + 1, length: SETUP_QUESTIONS.length })}
        title={q.prompt}
        titleClassName="wlx__question"
        subtitle={info ? undefined : q.hint}
        cardClassName="wlx__card"
        busy={state.thinking}
        back={<BackButton onBack={() => (state.index === 0 ? back() : dispatch({ type: 'back' }))} />}
        actions={
          <>
            {q.kind !== 'info' && (
              <Button variant="ghost" disabled={state.thinking} onClick={() => advance('skip')}>
                {t('firstRun.welcomeQuestions.skip')}
              </Button>
            )}
            <Button variant="primary" disabled={state.thinking || !questionAnswered(q, state)} onClick={() => advance('next')}>
              {q.kind === 'info' ? t('firstRun.welcomeQuestions.letSGo') : t('firstRun.welcomeQuestions.continue')}
            </Button>
          </>
        }
      >
        {info ? (
          <p className="wlx__assure">
            <ShieldCheck aria-hidden /> {q.hint}
          </p>
        ) : state.thinking ? (
          <div className="wlx__thinking" role="status">
            <span className="wlx__dots-think" aria-hidden="true"><i /><i /><i /></span>
            <span className="ui-sr-only">{t('firstRun.welcomeQuestions.thinking')}</span>
            <TipsCarousel />
          </div>
        ) : (
          <Card q={q} state={state} dispatch={dispatch} onSubmit={() => questionAnswered(q, state) && advance('next')} />
        )}
      </StepFrame>
    </>
  )
}

interface CardProps {
  q: SetupQuestion
  state: QuestionsState
  dispatch(action: Parameters<typeof reduce>[1]): void
  onSubmit(): void
}

function Card({ q, state, dispatch, onSubmit }: CardProps): ReactElement | null {
  switch (q.kind) {
    case 'info':
      return null
    case 'text':
      return <TextCard q={q} state={state} dispatch={dispatch} onSubmit={onSubmit} />
    case 'confirm':
      return <ConfirmCard q={q} state={state} dispatch={dispatch} onSubmit={onSubmit} />
    case 'single':
    case 'multi':
    case 'tools':
      return <ChoiceCard q={q} state={state} dispatch={dispatch} onSubmit={onSubmit} />
    case 'connector':
      return <InlineConnectors limit={3} />
  }
}

function TextCard({ q, state, dispatch, onSubmit }: CardProps): ReactElement {
  const t = useT()
  const id = useId()
  const value = typeof state.answers[q.id] === 'string' ? (state.answers[q.id] as string) : ''
  const set = (text: string): void => dispatch({ type: 'set', id: q.id, value: text })
  const dictation = useDictation((words) => set(value ? `${value} ${words}` : words))
  const listening = dictation.state === 'listening'
  return (
    <div className="co-field">
      <label className="ui-sr-only" htmlFor={id}>{q.prompt}</label>
      <div className="co-field__row">
        <input id={id} className="co-input" value={value} placeholder={q.placeholder} maxLength={300} autoFocus onChange={(e) => set(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
        {q.dictation && dictation.available && (
          <Button
            variant={listening ? 'primary' : 'secondary'}
            icon={listening ? <Square /> : <Mic />}
            aria-pressed={listening}
            loading={dictation.state === 'starting' || dictation.state === 'transcribing'}
            onClick={() => void (listening ? dictation.stop() : dictation.start())}
          >
            {listening ? t('firstRun.welcomeQuestions.stop') : t('firstRun.welcomeQuestions.speak')}
          </Button>
        )}
      </div>
      {listening && dictation.partial && <p className="co-hint" aria-live="polite">{dictation.partial}</p>}
      {dictation.error && <p className="co-field__error" role="alert">{t('firstRun.welcomeQuestions.theMicrophoneIsnT')}</p>}
    </div>
  )
}

function ConfirmCard({ q, state, dispatch, onSubmit }: CardProps): ReactElement {
  const t = useT()
  const id = useId()
  const detected = timeZone()
  const value = state.answers[q.id]
  const [correcting, setCorrecting] = useState(typeof value === 'string' && value !== detected)
  return (
    <div className="co-field">
      <p className="wlx__confirm-value">{detected}</p>
      {!correcting ? (
        <div className="wlx__row">
          <Button variant={value === detected ? 'primary' : 'secondary'} icon={<Check />} onClick={() => dispatch({ type: 'set', id: q.id, value: detected })}>
            {t('firstRun.welcomeQuestions.thatSRight')}
          </Button>
          <Button variant="ghost" onClick={() => setCorrecting(true)}>{t('firstRun.welcomeQuestions.correctIt')}</Button>
        </div>
      ) : (
        <>
          <label className="co-field__label" htmlFor={id}>{t('firstRun.welcomeQuestions.yourTimeZoneOr')}</label>
          <input id={id} className="co-input" autoFocus value={typeof value === 'string' ? value : ''} maxLength={80} onChange={(e) => dispatch({ type: 'set', id: q.id, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
        </>
      )}
    </div>
  )
}

function ChoiceCard({ q, state, dispatch, onSubmit }: CardProps): ReactElement {
  const t = useT()
  const otherId = useId()
  const multi = q.kind === 'multi'
  const value = state.answers[q.id]
  const selected = (id: string): boolean => (Array.isArray(value) ? value.includes(id) : value === id)
  const otherOn = multi ? Array.isArray(value) && value.includes('other') : value === 'other'
  const pick = (id: string): void => {
    if (multi) dispatch({ type: 'toggle', id: q.id, option: id })
    else dispatch({ type: 'set', id: q.id, value: id })
  }
  return (
    <div className="co-field">
      <div className="wlx__chips" role={multi ? 'group' : 'radiogroup'} aria-label={q.prompt}>
        {q.options?.map((o) => (
          <button key={o.id} type="button" className="wlx__chip" role={multi ? undefined : 'radio'} aria-checked={multi ? undefined : selected(o.id)} aria-pressed={multi ? selected(o.id) : undefined} onClick={() => pick(o.id)}>
            {selected(o.id) && <Check aria-hidden />}
            {o.label}
          </button>
        ))}
        {q.other && (
          <button type="button" className="wlx__chip" role={multi ? undefined : 'radio'} aria-checked={multi ? undefined : otherOn} aria-pressed={multi ? otherOn : undefined} onClick={() => pick('other')}>
            {t('firstRun.welcomeQuestions.other')}
          </button>
        )}
      </div>
      {q.other && otherOn && (
        <>
          <label className="ui-sr-only" htmlFor={otherId}>{t('firstRun.welcomeQuestions.other')}</label>
          <input id={otherId} className="co-input" autoFocus placeholder={t('firstRun.welcomeQuestions.tellMeInA')} maxLength={120} value={state.other[q.id] ?? ''} onChange={(e) => dispatch({ type: 'other', id: q.id, text: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && onSubmit()} />
        </>
      )}
    </div>
  )
}
