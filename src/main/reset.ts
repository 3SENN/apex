/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ResetResult } from '@shared/storage'

// Reset steps. "Reset Apex" runs every step in order; steps with
// `secrets: true` (the saved key, the password vault and wallet) run only when
// the "also delete the saved key and the password vault" box is ticked.

export interface ResetStep {
  id: string
  order: number
  label: string
  secrets?: boolean
  run(o: { dryRun: boolean }): Promise<ResetResult>
}

const steps = new Map<string, ResetStep>()

export function registerResetStep(s: ResetStep): () => void {
  if (steps.has(s.id)) throw new Error(`Reset step ${s.id} is already registered.`)
  steps.set(s.id, s)
  return () => {
    if (steps.get(s.id) === s) steps.delete(s.id)
  }
}

export function resetSteps(): ResetStep[] {
  return [...steps.values()].sort((a, b) => a.order - b.order)
}

/** Runs the steps in order; secret steps only with `secrets`. A dry run lists what would go. */
export async function runResetSteps(options: { secrets: boolean; dryRun: boolean }): Promise<ResetResult> {
  const removed: string[] = []
  for (const step of resetSteps()) {
    if (step.secrets && !options.secrets) continue
    const result = await step.run({ dryRun: options.dryRun })
    removed.push(...result.removed)
  }
  return { removed }
}
