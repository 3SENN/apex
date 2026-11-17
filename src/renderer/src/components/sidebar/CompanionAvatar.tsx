/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { ChatSummary } from '@shared/chats'
import type { Companion, CompanionMood } from '@shared/companion'
import { UserRound } from 'lucide-react'
import { FaceAvatar, useChatFace, type AvatarMark } from '../../companion'
import { useCompanionById } from '../shellContext'
import { cx } from '../../ui'
import { useT } from '../../i18n/useT'

interface AvatarProps {
  /** The companion to draw; null or unknown draws the neutral avatar. */
  companion: Companion | null
  size: number
  className?: string
  /** Spoken name; empty hides it when the row already names the companion. */
  label?: string
  /** The expression, for an avatar that stands for a chat; the corner mark follows it (DS-67). */
  mood?: CompanionMood
  /** Overrides the corner mark; null shows none. */
  mark?: AvatarMark | null
  unread?: boolean
}

/** A companion's face in its own colour (CO-18), rendered off-screen once per look and mood. */
export function CompanionAvatar({ companion, size, className, label, mood, mark, unread }: AvatarProps): ReactElement {
  const t = useT()
  if (companion) return <FaceAvatar look={companion.look} name={companion.name} size={size} mood={mood} mark={mark} unread={unread} className={className} label={label} />
  const name = label ?? t('tabs.sidebarCompanionAvatar.companionNoLongerAvailable')
  return (
    <span
      className={cx('avatar avatar--neutral', className)}
      style={{ width: size, height: size }}
      role={name ? 'img' : undefined}
      aria-label={name || undefined}
      aria-hidden={name ? undefined : true}
      title={name || undefined}
    >
      <UserRound size={Math.round(size * 0.62)} aria-hidden />
    </span>
  )
}

/**
 * The avatar for a companion id, from the shell's companion list. Pass
 * `chat` for a row that stands for a chat: its face and corner mark then
 * follow the chat live (working, needs you, done, error, unread), or `mood`
 * to set the expression yourself.
 */
export function CompanionAvatarById({
  id,
  size,
  className,
  label,
  mood,
  mark,
  chat,
}: {
  id: string | null | undefined
  size: number
  className?: string
  label?: string
  mood?: CompanionMood
  mark?: AvatarMark | null
  chat?: Pick<ChatSummary, 'id' | 'status' | 'unread' | 'needsInput'> | null
}): ReactElement {
  const companion = useCompanionById(id)
  const face = useChatFace(chat)
  const shownMood = mood ?? (chat ? face.mood : undefined)
  const shownMark = mark !== undefined ? mark : chat && mood === undefined ? face.mark : undefined
  return <CompanionAvatar companion={companion} size={size} className={className} label={label} mood={shownMood} mark={shownMark} unread={chat?.unread} />
}
