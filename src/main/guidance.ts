/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Dismissed tips and nudges (CH-29), kept for good in
// userData/guidance.json. Every change goes out as a 'guidance' event so the
// chat's working tip and the new tab's nudges hide at once everywhere.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { GuidanceService, GuidanceState } from '@shared/tips'
import { log } from './log'
import { writeAtomic } from './settings'

export const GUIDANCE_FILE = 'guidance.json'
/** Lists are capped so the file can't grow without bound. */
export const GUIDANCE_MAX = 500

const fileSchema = z.object({
  version: z.literal(1),
  dismissedTips: z.array(z.string().max(128)).max(GUIDANCE_MAX),
  dismissedNudges: z.array(z.string().max(128)).max(GUIDANCE_MAX),
})

export function createGuidanceService(options: { dataDir: string; onChange?(state: GuidanceState): void }): GuidanceService {
  const path = join(options.dataDir, GUIDANCE_FILE)
  let state: GuidanceState = { dismissedTips: [], dismissedNudges: [] }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (parsed.success) state = { dismissedTips: parsed.data.dismissedTips, dismissedNudges: parsed.data.dismissedNudges }
  } catch {
    // A first run, or an unreadable file: nothing dismissed.
  }
  const add = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id].slice(-GUIDANCE_MAX))
  const set = (next: GuidanceState): void => {
    if (next.dismissedTips === state.dismissedTips && next.dismissedNudges === state.dismissedNudges) return
    state = next
    try {
      writeAtomic(path, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
    } catch (err) {
      log.warn('guidance', 'Could not save dismissed tips', { error: err instanceof Error ? err.message : String(err) })
    }
    options.onChange?.(state)
  }
  return {
    state: () => ({ dismissedTips: [...state.dismissedTips], dismissedNudges: [...state.dismissedNudges] }),
    dismissTip(id) {
      const tips = add(state.dismissedTips, id)
      if (tips !== state.dismissedTips) set({ ...state, dismissedTips: tips })
    },
    dismissNudge(id) {
      const nudges = add(state.dismissedNudges, id)
      if (nudges !== state.dismissedNudges) set({ ...state, dismissedNudges: nudges })
    },
  }
}
