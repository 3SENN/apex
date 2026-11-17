/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompanionLook } from '@shared/companion'
import { randomizeLook, type Rng } from '@shared/companionLogic'
import type { CompanionAssets } from './assets'

export { Companion, type CompanionProps } from './Companion'
export { CompanionStill, useCompanionWalk, type CompanionStillProps } from './Still'
export { FaceAvatar, type FaceAvatarProps } from './FaceAvatar'
export { Bubble, type BubbleProps } from './Bubble'
export { assetUrl, loadCompanionAssets, type CompanionAssets } from './assets'
export { renderCompanionImage, type RenderOptions } from './render'
export { companionImage, useCompanionImage, type ImageOptions } from './images'
export { caretPoint, useCaretGaze } from './caret'
export type { CompanionFraming } from './layout'
export type { LookTarget } from './view'
export {
  cheerCompanion,
  moodMark,
  signalPresence,
  summaryMood,
  useChatFace,
  useChatPresence,
  useCompanionPresence,
  usePresenceSignal,
  wakePresence,
  type AvatarMark,
  type IdleStage,
  type PresenceSignal,
} from './presence'
export type { CompanionMood } from '@shared/companion'

/** A random look: weighted by randomization-config and only with parts the head accepts. */
export function randomLook(assets: CompanionAssets, rng: Rng = Math.random): CompanionLook {
  return randomizeLook(assets.randomization, assets.compatibility, rng)
}
