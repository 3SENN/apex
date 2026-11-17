/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ShotSpec, SmokeCheck } from './types'
import { mainMenuChecks, mainMenuShots } from './menusMain'
import { dialogChecks, dialogShots } from './menusDialogs'
import { downloadChecks, downloadShots } from './menusDownloads'

// The menus' smoke checks and light and dark shots.
export const checks: SmokeCheck[] = [
  ...mainMenuChecks,
  ...dialogChecks,
  ...downloadChecks,
]
export const shots: ShotSpec[] = [
  ...mainMenuShots,
  ...dialogShots,
  ...downloadShots,
]
