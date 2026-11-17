/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useReducer, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, ChevronLeft, ChevronRight, ExternalLink, MessageCircle } from 'lucide-react'
import type { LogItem } from '../../agentLog'
import { atelier, call, errorText } from '../../api'
import { useT } from '../../i18n/useT'
import { Button, cx, toast } from '../../ui'
import { CompanionAvatar } from '../CompanionAvatar'
import { useCompanion } from '../hooks'
import { answerFor, answeredCount, initialQuestionState, questionAnswers, reduceQuestions } from '../logic/requests'
import type { RequestCardProps } from '../requestCards'
import { useChat } from '../store'
import '../chatTools.css'

// CH-44 on DS-63's visuals: the agent's questions one at a time, with
// suggested answers and a free-text answer, previous and next, skip one,
// skip all, and a submit that counts the answers. Locked after submit.

type QuestionItem = Extract<LogItem, { kind: 'question' }>

export function QuestionCard({ request, chatId, done }: RequestCardProps): ReactElement {
  const t = useT()
  const item = request.data as QuestionItem
  const questions = item.questions
  const total = questions.length
  const chat = useChat(chatId)
  const companion = useCompanion(chat.setup?.companionId ?? chat.summary?.companionId ?? null)
  const [state, dispatch] = useReducer(reduceQuestions, undefined, initialQuestionState)
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const question = questions[state.index]
  const answered = answeredCount(state, questions)
  const locked = state.submitted || busy

  const send = async (skipAll: boolean): Promise<void> => {
    if (locked) return
    setBusy(true)
    try {
      await call('agent', 'respond', chatId, item.id, { kind: 'question', answers: skipAll ? null : questionAnswers(state, questions) })
      dispatch({ type: 'submit' })
      done({ answered: skipAll ? 0 : answered })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      setBusy(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        if (state.index < total - 1) dispatch({ type: 'next', total })
        else void send(false)
      }
      return
    }
    if (e.key === 'ArrowRight' && state.index < total - 1) dispatch({ type: 'next', total })
    else if (e.key === 'ArrowLeft' && state.index > 0) dispatch({ type: 'prev' })
  }

  if (!question) return <div className="cd-question" />
  const current = answerFor(state, question)
  const picked = (option: string): boolean => (Array.isArray(state.answers[question.id]) ? (state.answers[question.id] as string[]).includes(option) : state.answers[question.id] === option)
  const showOther = question.allowOther !== false || !question.options?.length

  return (
    <div className={cx('cd-question', locked && 'cd-question--locked')} role="group" aria-label={t('chatTools.question.heading', { name: companion?.name ?? '', count: total })} onKeyDown={onKey}>
      <div className="cd-question__head">
        {/* DS-67: the question mark sits beside the floating head, never on it. */}
        <span className="cd-question__face">
          <CompanionAvatar companion={companion} size={24} mood="approval" label="" />
          <MessageCircle size={12} className="cd-question__mark" aria-hidden="true" />
        </span>
        <span className="cd-question__progress" aria-live="polite">{total > 1 ? t('chatTools.question.progress', { n: state.index + 1, total }) : t('chatTools.question.heading', { name: companion?.name ?? '', count: 1 })}</span>
      </div>
      <p className="cd-question__prompt" id={`q-${item.id}-${question.id}`}>{question.prompt}</p>
      {question.detail && <p className="cd-question__detail">{question.detail}</p>}
      {question.link && (
        <button type="button" className="cd-question__link" disabled={locked} onClick={() => question.link && /^https?:\/\//i.test(question.link.url) && void atelier.tabs.create(question.link.url).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))}>
          <ExternalLink size={13} aria-hidden="true" />
          {t('chatTools.question.lookFirst', { title: question.link.title })}
        </button>
      )}
      {question.options && question.options.length > 0 && (
        <div className="cd-question__options" role={question.multi ? 'group' : 'radiogroup'} aria-labelledby={`q-${item.id}-${question.id}`}>
          {question.multi && <p className="cd-question__hint">{t('chatTools.question.multi')}</p>}
          {question.options.map((option) => {
            const on = picked(option)
            return (
              <button
                key={option}
                type="button"
                role={question.multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={cx('cd-question__option', on && 'cd-question__option--on')}
                disabled={locked}
                onClick={() => dispatch({ type: 'pick', id: question.id, option, multi: question.multi === true })}
              >
                <span className="cd-question__marker" aria-hidden="true">{on && <Check size={12} strokeWidth={2.5} />}</span>
                <span>{option}</span>
              </button>
            )
          })}
        </div>
      )}
      {showOther && (
        <input
          ref={field}
          type="text"
          className="cd-question__other"
          value={state.other[question.id] ?? ''}
          maxLength={2000}
          placeholder={t('chatTools.question.other')}
          aria-label={t('chatTools.question.other')}
          disabled={locked}
          onChange={(e) => dispatch({ type: 'other', id: question.id, text: e.target.value })}
        />
      )}
      <div className="cd-question__footer">
        {total > 1 && (
          <span className="cd-question__nav">
            <Button size="sm" variant="ghost" icon={<ChevronLeft size={14} />} disabled={locked || state.index === 0} onClick={() => dispatch({ type: 'prev' })}>{t('chatTools.question.previous')}</Button>
            <Button size="sm" variant="ghost" iconEnd={<ChevronRight size={14} />} disabled={locked || state.index >= total - 1} onClick={() => dispatch({ type: 'next', total })}>{t('chatTools.question.next')}</Button>
          </span>
        )}
        <span className="cd-question__spacer" />
        <Button size="sm" variant="ghost" disabled={locked || current === null && state.skipped.includes(question.id)} onClick={() => dispatch({ type: 'skip', id: question.id, total })}>{t('chatTools.question.skip')}</Button>
        {total > 1 && <Button size="sm" variant="ghost" disabled={locked} onClick={() => void send(true)}>{t('chatTools.question.skipAll')}</Button>}
        <Button size="sm" variant="primary" className="chat-co-button" loading={busy} disabled={state.submitted} onClick={() => void send(false)}>
          {state.submitted ? t('chatTools.question.sent') : t('chatTools.question.submit', { count: answered })}
        </Button>
      </div>
    </div>
  )
}
