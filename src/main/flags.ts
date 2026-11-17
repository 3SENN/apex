/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://flags in main (ST-57): the values live in the `flags`
// setting; this keeps what was set at launch so the page can say which
// changes wait for a restart, and relaunches when asked.
import { app } from 'electron'
import { applyFlag, flagStates, isFlagOn, type FlagState, type FlagsService } from '@shared/flags'
import { log } from './log'

interface FlagSettings {
  get(): { flags: Record<string, string> }
  update(patch: { flags: Record<string, string> }): unknown
}

export interface FlagsDeps {
  settings: FlagSettings
  broadcast(event: { type: 'flags'; values: Record<string, string> }): void
  /** Smoke runs never relaunch. */
  relaunch?(): void
}

export function createFlags(deps: FlagsDeps): FlagsService & { isOn(id: string): boolean; values(): Record<string, string> } {
  const values = (): Record<string, string> => ({ ...(deps.settings.get().flags ?? {}) })
  const launch = values()
  const list = (): FlagState[] => flagStates(values(), launch)
  return {
    list,
    set(id, value) {
      const next = applyFlag(values(), id, value)
      deps.settings.update({ flags: next })
      log.info('flags', `${id} set to ${value}`)
      deps.broadcast({ type: 'flags', values: next })
      return list()
    },
    relaunch() {
      if (deps.relaunch) return deps.relaunch()
      app.relaunch()
      app.exit(0)
    },
    isOn: (id) => isFlagOn(values(), id),
    values,
  }
}
