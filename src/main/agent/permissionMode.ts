/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { guardAction, type GuardedAction, type GuardResult } from './guard'

// CH-18: each chat either asks before consequential actions (the default) or
// acts without asking. Actions the agent tools mark always-ask (payments, account
// security) ask in both modes, and password, one-time-code and payment
// fields stay blocked outright in the executor whatever the mode.

/** Whether the executor stops for your OK before this action. */
export function needsApproval(askFirst: boolean, guard: GuardResult | null): boolean {
  if (!guard) return false
  return guard.alwaysAsk || askFirst
}

/** The guard's reading of an action, and whether this chat's mode asks for it. */
export function approvalFor(action: GuardedAction, askFirst: boolean): GuardResult | null {
  const guard = guardAction(action)
  return needsApproval(askFirst, guard) ? guard : null
}

/** A new chat's mode follows the global "ask before consequential actions" setting. */
export function initialActWithoutAsking(confirmConsequentialActions: boolean): boolean {
  return !confirmConsequentialActions
}
