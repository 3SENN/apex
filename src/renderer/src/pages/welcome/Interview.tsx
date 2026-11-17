/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The setup conversation (ON-18): the companion gets to know you one question
// at a time, following up on what you say. Answering is mostly tapping: big
// suggestion chips with an emoji, several at once when several apply (your
// apps, what you want help with), then Done; a small row underneath takes
// your own words, typed or spoken. Your last answer stays as a chat bubble
// under the question, and dots show how far along it is. "That's enough"
// ends it whenever you like; a turn that fails ends it too, with what was
// said so far. Then main turns it into your profile and the workspace it asks
// for, which the next step shows before setting anything. It runs on the
// engine you just connected; without one setup shows the question cards.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { ArrowUp, Check, Mic, Square } from 'lucide-react'
import { INTERVIEW_LIMITS, INTERVIEW_MAX_QUESTIONS, type InterviewLine, type InterviewTurn } from '@shared/userProfile'
import { call, errorText } from '../../api'
import { useDictation } from '../../chat/dictation/useDictation'
import { TipsCarousel } from '../../guidance/TipsCarousel'
import { Button, IconButton } from '../../ui'
import { BackButton, type StepProps } from './WelcomeFlow'
import { StepFrame, StepScene } from './StepFrame'
import { useT } from '../../i18n/useT'
import { isWindows } from '../../system/platform'

interface InterviewProps extends StepProps {
  /** The companion's opening line, already fetched (it decided this step is a conversation). */
  first: InterviewTurn
}

export function InterviewStep({ first, next, back, say }: InterviewProps): ReactElement {
  const t = useT()
  const inputId = useId()
  const [lines, setLines] = useState<InterviewLine[]>([{ from: 'companion', text: first.say }])
  const [turn, setTurn] = useState<InterviewTurn>(first)
  const [picked, setPicked] = useState<string[]>([])
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<'asking' | 'thinking' | 'finishing'>('asking')
  const [error, setError] = useState<string | null>(null)
  const dictation = useDictation((words) => setText((v) => (v ? `${v} ${words}` : words)))
  const listening = dictation.state === 'listening'
  const asked = lines.filter((l) => l.from === 'companion').length
  const lastAnswer = [...lines].reverse().find((l) => l.from === 'you')?.text ?? null

  useEffect(() => say(phase === 'thinking' ? t('firstRun.interview.thinking') : turn.say), [turn, phase])

  /** Ends the chat: your profile and its workspace plan, then the review step. */
  const finish = async (all: InterviewLine[]): Promise<void> => {
    setPhase('finishing')
    setError(null)
    try {
      await call('onboarding', 'finishInterview', all.slice(-INTERVIEW_LIMITS.lines))
      next()
    } catch (err) {
      setError(errorText(err))
      setPhase('asking')
    }
  }

  const answer = async (reply: string): Promise<void> => {
    const words = reply.trim().slice(0, INTERVIEW_LIMITS.text)
    if (!words || phase !== 'asking') return
    if (listening) void dictation.stop()
    const sofar: InterviewLine[] = [...lines, { from: 'you', text: words }]
    setLines(sofar)
    setText('')
    setPicked([])
    setPhase('thinking')
    const nextTurn = await call('onboarding', 'interviewTurn', sofar.slice(-INTERVIEW_LIMITS.lines)).catch(() => null)
    // No engine any more, or a failed turn: what you said so far is enough to go on with.
    if (!nextTurn) return void finish(sofar)
    const withReply: InterviewLine[] = [...sofar, { from: 'companion', text: nextTurn.say }]
    setLines(withReply)
    setTurn(nextTurn)
    if (nextTurn.done) return void finish(withReply)
    setPhase('asking')
  }

  // Several picks (and anything typed) go as one answer.
  const sendPicks = (): void => void answer([...picked, text.trim()].filter(Boolean).join(', '))
  const send = (): void => (turn.multi ? sendPicks() : void answer(text))
  const tap = (chip: string): void => {
    if (!turn.multi) return void answer(chip)
    setPicked((p) => (p.includes(chip) ? p.filter((c) => c !== chip) : [...p, chip]))
  }

  const progress = (
    <span className="iv-dots" role="img" aria-label={t('firstRun.interview.progress', { count: asked })}>
      {Array.from({ length: INTERVIEW_MAX_QUESTIONS }, (_, i) => (
        <i key={i} data-on={i < asked || undefined} />
      ))}
    </span>
  )

  if (phase === 'finishing') {
    return (
      <>
        <StepScene tiles={[]} />
        <StepFrame title={turn.done ? turn.say : t('firstRun.interview.thanks')} busy actions={null}>
          <div className="wlx__thinking" role="status">
            <span className="wlx__dots-think" aria-hidden="true"><i /><i /><i /></span>
            {t('firstRun.interview.finishing')}
            <TipsCarousel />
          </div>
        </StepFrame>
      </>
    )
  }

  return (
    <>
      <StepScene tiles={[]} />
      <StepFrame
        eyebrow={progress}
        title={turn.say}
        titleClassName="wlx__question"
        cardClassName="wlx__card iv"
        busy={phase === 'thinking'}
        back={<BackButton onBack={back} />}
        actions={
          <>
            <Button variant="ghost" disabled={phase !== 'asking'} onClick={() => void finish(lines)}>
              {asked > 1 ? t('firstRun.interview.enough') : t('firstRun.interview.skip')}
            </Button>
            {turn.multi && (
              <Button variant="primary" icon={<Check />} disabled={phase !== 'asking' || (picked.length === 0 && !text.trim())} onClick={sendPicks}>
                {picked.length > 0 ? t('firstRun.interview.doneCount', { count: picked.length }) : t('firstRun.interview.done')}
              </Button>
            )}
          </>
        }
      >
        {lastAnswer && (
          <p className="iv-you" aria-label={t('firstRun.interview.yourLastAnswer')}>
            <span>{lastAnswer}</span>
          </p>
        )}
        {phase === 'thinking' ? (
          <div className="wlx__thinking" role="status">
            <span className="wlx__dots-think" aria-hidden="true"><i /><i /><i /></span>
            <span className="ui-sr-only">{t('firstRun.interview.thinking')}</span>
            <TipsCarousel />
          </div>
        ) : (
          <>
            {turn.chips.length > 0 && (
              <div className="iv-chips" role="group" aria-label={t('firstRun.interview.quickReplies')}>
                {turn.chips.map((chip) => {
                  const on = picked.includes(chip)
                  return (
                    <button key={chip} type="button" className="iv-chip" aria-pressed={turn.multi ? on : undefined} onClick={() => tap(chip)}>
                      {chip}
                      {on && <Check aria-hidden />}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="iv-own">
              <label className="ui-sr-only" htmlFor={inputId}>{t('firstRun.interview.yourAnswer')}</label>
              <input
                id={inputId}
                className="iv-own__input"
                value={text}
                autoFocus={turn.chips.length === 0}
                placeholder={turn.chips.length > 0 ? t('firstRun.interview.orType') : t('firstRun.interview.placeholder')}
                maxLength={INTERVIEW_LIMITS.text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
              />
              {dictation.available && (
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={listening ? t('firstRun.welcomeQuestions.stop') : t('firstRun.welcomeQuestions.speak')}
                  icon={listening ? <Square /> : <Mic />}
                  pressed={listening}
                  onClick={() => void (listening ? dictation.stop() : dictation.start())}
                />
              )}
              <IconButton size="sm" variant="subtle" label={t('firstRun.interview.send')} icon={<ArrowUp />} disabled={!text.trim()} onClick={send} />
            </div>
            {listening && dictation.partial && <p className="co-hint" aria-live="polite">{dictation.partial}</p>}
            {error && <p className="co-field__error" role="alert">{t('firstRun.interview.failed', { error })}</p>}
            {asked === 1 && <p className="iv-note">{t((isWindows() ? 'firstRun.interview.privacy.win' : 'firstRun.interview.privacy'))}</p>}
          </>
        )}
      </StepFrame>
    </>
  )
}
