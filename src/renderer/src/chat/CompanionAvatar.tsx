/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement } from 'react'
import { UserRound } from 'lucide-react'
import type { CompanionMood } from '@shared/companion'
import type { Companion } from '@shared/services'
import { FaceAvatar } from '../companion/FaceAvatar'
import type { AvatarMark } from '../companion/presence'
import { cx } from '../ui'
import { useT } from '../i18n/useT'

export type { AvatarMark }

export interface CompanionAvatarProps {
  /** undefined while companions load; null for a deleted companion (neutral avatar). */
  companion: Companion | null | undefined
  size?: number
  className?: string
  /** Makes it a button, e.g. to open the profile card. */
  onClick?(): void
  label?: string
  /** Where the avatar stands for a chat: the chat's state, drawn as the face's expression (CO-18). */
  mood?: CompanionMood
  /** The corner mark (DS-67); none by default. */
  mark?: AvatarMark | null
}

/**
 * The companion's face in a chat (CO-18, DS-134): the same FaceAvatar render
 * as the sidebar rows, with its marks, so a chat's state reads the same
 * everywhere. As a button it opens the profile card, with no hover effect
 * (DS-52).
 */
export function CompanionAvatar({ companion, size = 24, className, onClick, label, mood, mark = null }: CompanionAvatarProps): ReactElement {
  const t = useT()
  const name = label ?? (companion ? companion.name : companion === null ? t('chat.companionAvatar.removedCompanion') : t('chat.companionAvatar.companion'))
  const style = { width: size, height: size } as CSSProperties
  const body = companion ? (
    <FaceAvatar look={companion.look} name={companion.name} size={size} mood={mood} mark={mark} label={onClick ? '' : name} />
  ) : (
    <UserRound size={Math.round(size * 0.6)} aria-hidden="true" />
  )
  const classes = cx('chat-avatar', !companion && 'chat-avatar--neutral', onClick && 'chat-avatar--button', className)
  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick} aria-label={name}>
        {body}
      </button>
    )
  }
  if (companion) return <span className={classes} style={style}>{body}</span>
  // An empty label means the row around it already names the companion.
  return (
    <span className={classes} style={style} role={name ? 'img' : undefined} aria-label={name || undefined} aria-hidden={name ? undefined : true} title={name || undefined}>
      {body}
    </span>
  )
}
