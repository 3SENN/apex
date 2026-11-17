/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Checks for the optional "you" picture. The file is downscaled in the
// chrome before it is saved, so only the source file's type and size are
// checked here; main validates the final data URL again.
import { AVATAR_MAX } from '@shared/ipc'
import { t } from '@shared/i18n/core'

/** Source pictures above this are refused before decoding. */
export const AVATAR_FILE_MAX = 15 * 1024 * 1024
/** The saved picture is a square of this many pixels. */
export const AVATAR_PIXELS = 256

const SOURCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'])
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/** A readable reason the file can't be used, or null when it can. */
export function avatarFileError(file: { type: string; size: number; name?: string }): string | null {
  const type = file.type.toLowerCase()
  if (!type.startsWith('image/') || type === 'image/svg+xml') return t('settings.avatar.thatFileIsnT')
  if (!SOURCE_TYPES.has(type)) return t('settings.avatar.apexCanTRead')
  if (file.size > AVATAR_FILE_MAX) return t('settings.avatar.thatPictureIsOver', { value: Math.round(AVATAR_FILE_MAX / 1024 / 1024) })
  if (file.size === 0) return t('settings.avatar.thatFileIsEmpty')
  return null
}

/** Whether main will accept this as the saved avatar. */
export function isAvatarDataUrl(value: string): boolean {
  return value.length <= AVATAR_MAX && DATA_URL.test(value)
}

/** The centred square of a picture, for drawing it into the avatar canvas. */
export function squareCrop(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.max(0, Math.min(width, height))
  return { sx: Math.round((width - size) / 2), sy: Math.round((height - size) / 2), size }
}

/** The first letter of a name for monogram avatars; '' when there is none. */
export function initialOf(name: string): string {
  const first = [...name.trim()][0] ?? ''
  return first.toLocaleUpperCase()
}
