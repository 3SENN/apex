/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { t } from '@shared/i18n/core'
import { StatusDot } from '../ui'
import { useRunningRoutines } from './routineRunning'

/** A still dot on the sidebar's Routines row while a routine runs (DS-28: nothing loops in the chrome). */
export function RoutineRunningDot(): ReactElement | null {
  const running = useRunningRoutines()
  if (running.size === 0) return null
  return <StatusDot status="working" size={6} label={t('atWork.routines.runningDot')} pulse={false} />
}
