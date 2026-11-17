/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement, type RefObject } from 'react'
import { Check, MessageCircle, Mic, PenLine } from 'lucide-react'
import type { Companion } from '@shared/services'
import { cx } from '../ui'
import { CompanionAvatar } from './CompanionAvatar'
import type { ComposerHandle } from './Composer'
import { useT } from '../i18n/useT'

// DS-63: what a reply shows when the agent asks you something or suggests
// next steps through its tools (CH-44 question cards, CH-27 follow-ups). The
// blocks only talk to the composer: hovering previews text in it, a click
// puts text into the draft, and they lock once you send or while a reply streams.

/** The opening phrase a typed answer starts with (shown as a preview on hover). */
export const ANSWER_OPENER = 'About that: '

export interface QuestionBlockProps {
  companion: Companion | null | undefined
  question: string
  detail?: string
  composer: RefObject<ComposerHandle | null>
  /** Answer by voice; defaults to dictating into the composer (DS-63). */
  onVoice?(): void
  locked: boolean
}

export function QuestionBlock({ companion, question, detail, composer, onVoice, locked }: QuestionBlockProps): ReactElement {
  // DS-63: the voice pill starts dictation in the composer, so the spoken answer lands in the draft.
  const t = useT()
  const voice = onVoice ?? (() => composer.current?.dictate())
  return (
    <div className={cx('chat-ask', locked && 'chat-ask--locked')}>
      <span className="chat-ask__face">
        <CompanionAvatar companion={companion} size={24} mood="approval" label="" />
        <span className="chat-ask__badge" aria-hidden="true"><MessageCircle size={9} strokeWidth={3} /></span>
      </span>
      <p className="chat-ask__question">{question}</p>
      {detail && <p className="chat-ask__detail">{detail}</p>}
      <div className="chat-ask__replies">
        {voice && (
          <button type="button" className="chat-ask__voice" disabled={locked} onClick={voice}>
            <Mic size={16} aria-hidden="true" />
            {t('chat.requestBlocks.answerByVoice')}
          </button>
        )}
        <button
          type="button"
          className="chat-ask__write"
          disabled={locked}
          onMouseEnter={() => composer.current?.preview(`${ANSWER_OPENER}…`)}
          onMouseLeave={() => composer.current?.preview(null)}
          onFocus={() => composer.current?.preview(`${ANSWER_OPENER}…`)}
          onBlur={() => composer.current?.preview(null)}
          onClick={() => composer.current?.insert(ANSWER_OPENER)}
        >
          <PenLine size={14} aria-hidden="true" />
          {t('chat.requestBlocks.writeAnAnswer')}
        </button>
      </div>
    </div>
  )
}

export interface NextStepsProps {
  heading?: string | null
  steps: readonly string[]
  composer: RefObject<ComposerHandle | null>
  locked: boolean
}

export function NextSteps({ heading, steps, composer, locked }: NextStepsProps): ReactElement {
  const t = useT()
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set())
  const toggle = (index: number, step: string): void => {
    composer.current?.toggleStep(step)
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  return (
    <div className={cx('chat-steps', locked && 'chat-steps--locked')}>
      <h4 className="chat-steps__heading">{heading?.trim() || t('chat.requestBlocks.whereWeCouldGo')}</h4>
      <ul className="chat-steps__list">
        {steps.map((step, i) => {
          const on = picked.has(i)
          return (
            <li key={step}>
              <button
                type="button"
                className={cx('chat-steps__row', on && 'chat-steps__row--on')}
                aria-pressed={on}
                disabled={locked}
                onMouseEnter={() => composer.current?.preview(step)}
                onMouseLeave={() => composer.current?.preview(null)}
                onFocus={() => composer.current?.preview(step)}
                onBlur={() => composer.current?.preview(null)}
                onClick={() => toggle(i, step)}
              >
                <span className="chat-steps__marker" aria-hidden="true">{on ? <Check size={14} strokeWidth={2.5} /> : i + 1}</span>
                <span className="chat-steps__text">{step}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
