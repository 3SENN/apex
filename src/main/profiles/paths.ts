/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'

// Where a profile's files live (SH-64): the default profile keeps its
// data in the data folder itself; every other profile has profiles/<id>/.

export const PROFILES_DIR = 'profiles'
export const PROFILES_FILE = 'profiles.json'
export const PROFILE_SETTINGS_FILE = 'profile-settings.json'

export function profileDataDir(root: string, id: string): string {
  return id === DEFAULT_PROFILE_ID ? root : join(root, PROFILES_DIR, id)
}
