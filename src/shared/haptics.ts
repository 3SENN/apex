/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Trackpad haptics (SH-41) and the lid pause for meeting recordings:
// the shapes main and the chrome share.

export type HapticKind = 'alignment' | 'level-change' | 'generic'

export interface HapticsServices {
  haptics: {
    /** A no-op off macOS, without the addon, or with settings.haptics off; rate-limited to one per 80 ms. */
    perform(kind: HapticKind): void
  }
}

export type LidPolicyEvent = 'lid-closed' | 'lid-opened' | 'suspend' | 'resume'
export type LidRecordingState = 'none' | 'recording' | 'paused'
export type LidPausedBy = 'user' | 'lid' | null
export type LidAction = 'pause' | 'resume' | 'none'
