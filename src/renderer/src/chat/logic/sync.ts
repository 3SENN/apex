/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent, AgentStatus } from '@shared/ipc'
import { EMPTY_LOG, foldAgentLog, reduceAgentLog, type AgentLog } from '../../agentLog'

// Keeps one chat's log in step with main: a surface loads the chat's view
// (compacted log plus the `seq` it covers) and then applies only newer live
// events. Events that arrive while the view is loading wait in `pending`, so
// nothing between the request and the reply is lost or applied twice.

export interface PendingEvent {
  seq: number
  event: AgentEvent
}

export interface LiveLog {
  log: AgentLog
  /** The newest event folded into `log`. */
  seq: number
  /** Non-null while a view is loading. */
  pending: PendingEvent[] | null
}

/** A chat whose view has been requested but not received yet. */
export const LOADING_LOG: LiveLog = { log: EMPTY_LOG, seq: 0, pending: [] }

export function beginLoad(state: LiveLog): LiveLog {
  return state.pending ? state : { ...state, pending: [] }
}

export function receiveEvent(state: LiveLog, event: AgentEvent, seq: number): LiveLog {
  if (state.pending) return { ...state, pending: [...state.pending, { seq, event }] }
  if (seq <= state.seq) return state
  return { ...state, seq, log: reduceAgentLog(state.log, event) }
}

/** Replaces the log with a loaded view, then applies the events that are newer than it. */
export function applyView(state: LiveLog, view: { log: readonly AgentEvent[]; seq: number; agentStatus: AgentStatus }): LiveLog {
  let log = foldAgentLog(view.log, view.agentStatus)
  let seq = view.seq
  for (const pending of state.pending ?? []) {
    if (pending.seq <= seq) continue
    log = reduceAgentLog(log, pending.event)
    seq = pending.seq
  }
  return { log, seq, pending: null }
}
