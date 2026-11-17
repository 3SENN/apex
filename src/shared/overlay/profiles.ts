/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `profiles`: the create and delete profile
// dialogs. Components and policies live in
// src/renderer/src/overlay/surfaces/profiles/index.ts.
export const PROFILES_SURFACES = ['profile-create', 'profile-delete'] as const

export type ProfilesSurfaceId = (typeof PROFILES_SURFACES)[number]

export interface ProfilesSurfaceProps {
  'profile-create': Record<string, never>
  'profile-delete': { profileId: string }
}
