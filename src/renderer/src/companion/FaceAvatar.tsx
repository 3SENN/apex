/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement } from 'react'
import { Check, MessageCircleQuestionMark, Repeat } from 'lucide-react'
import type { CompanionLook, CompanionMood } from '@shared/companion'
import { useCompanionImage } from './images'
import { moodMark, type AvatarMark } from './presenceCore'
import './companion.css'
import { t, type MessageKey } from '@shared/i18n/core'

export interface FaceAvatarProps {
  look: CompanionLook
  name: string
  /** CSS pixels. */
  size: number
  /** The expression, for an avatar that stands for a chat (idle, working, asking, done, error). */
  mood?: CompanionMood
  /** The state mark beside the head; by default it follows the mood (and `unread`). Null shows none. */
  mark?: AvatarMark | null
  unread?: boolean
  dimmed?: boolean
  /** A soft contact shadow under the head. */
  shadow?: boolean
  className?: string
  /** Spoken name; empty hides it when the row already names the companion. */
  label?: string
  style?: CSSProperties
}

const MARK_WORDS: Record<AvatarMark, MessageKey> = {
  working: 'core.faceAvatar.working',
  approval: 'core.faceAvatar.needsYou',
  unread: 'core.faceAvatar.unread',
  done: 'core.faceAvatar.done',
  error: 'core.faceAvatar.error',
  routine: 'core.faceAvatar.routine',
}

/**
 * A companion's head, floating free (CO-18): the head, hair, ears and hat,
 * centred on the eyes, with no body, frame, disc or ring, so it reads at
 * 16 px. A chat's state never touches the face (DS-67): it is its own small
 * mark beside the head, in the row's flow, and when there is none its space
 * collapses so titles line up. `shadow` adds a soft contact shadow under the
 * chin for heads that sit on a coloured surface.
 */
export function FaceAvatar({ look, name, size, mood = 'idle', mark, unread = false, dimmed = false, shadow = false, className, label, style }: FaceAvatarProps): ReactElement {
  // Twice the size (at least 48 px) keeps it crisp on Retina screens.
  const image = useCompanionImage(look, Math.max(48, Math.round(size * 2)), { mood, framing: 'face' })
  const shown = mark === undefined ? moodMark(mood, unread) : mark
  const spoken = label ?? name
  const full = spoken && shown ? `${spoken}, ${t(MARK_WORDS[shown])}` : spoken
  return (
    <span
      className={['face-avatar', shown && `face-avatar--${shown}`, dimmed && 'face-avatar--dimmed', shadow && 'face-avatar--shadow', size <= 20 && 'face-avatar--tiny', className].filter(Boolean).join(' ')}
      style={{ ['--face-size' as string]: `${size}px`, ['--face-tint' as string]: look.colors.skin, ['--face-accent' as string]: look.colors.accent, ...style }}
      role={full ? 'img' : undefined}
      aria-label={full || undefined}
      aria-hidden={full ? undefined : true}
      title={full || undefined}
    >
      <span className="face-avatar__head">
        {image ? <img src={image} alt="" draggable={false} /> : <span className="face-avatar__initial">{name.charAt(0).toUpperCase()}</span>}
      </span>
      {shown && (
        <span className="face-avatar__mark" aria-hidden="true">
          {shown === 'working' && (
            <>
              <i />
              <i />
            </>
          )}
          {shown === 'done' && <Check strokeWidth={4} />}
          {shown === 'approval' && <MessageCircleQuestionMark strokeWidth={2.6} />}
          {shown === 'routine' && <Repeat strokeWidth={2.6} />}
        </span>
      )}
    </span>
  )
}
