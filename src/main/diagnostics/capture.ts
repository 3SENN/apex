/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { basename } from 'node:path'
import { format } from 'node:util'
import { app, type WebContents } from 'electron'
import { errorMessage, isEchoing, log } from '../log'
import { logger } from './logger'
import { originOf } from './redact'

// Diagnostics capture: what reaches the log without a log.* call.
// Main's console.warn and console.error, uncaught errors, renderer and child
// process exits, unresponsive pages, and the chrome's console warnings and
// errors. Only kinds, reasons, codes and origins are recorded, never page
// text, titles or full URLs.

let processInstalled = false
let appInstalled = false
let inCapture = false

/** Wraps console.warn/error and listens for uncaught errors. Safe before app ready; runs once. */
export function installProcessCapture(): void {
  if (processInstalled) return
  processInstalled = true
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      // The facade echoes its own lines here; those are already in the log.
      if (isEchoing() || inCapture) return
      inCapture = true
      try {
        log[level]('main', format(...args))
      } finally {
        inCapture = false
      }
    }
  }
  // The monitor leaves Electron's own handling of the error as it is.
  process.on('uncaughtExceptionMonitor', (err) => {
    log.error('crash', `Uncaught exception: ${errorMessage(err)}`, { name: err instanceof Error ? err.name : 'Error', stack: topOfStack(err) })
    logger.flushSync()
  })
  process.on('unhandledRejection', (reason) => {
    log.error('crash', `Unhandled rejection: ${errorMessage(reason)}`, { stack: topOfStack(reason) })
    logger.flushSync()
  })
  process.on('exit', () => logger.flushSync())
}

/** The first few frames, for finding the code; redacted on write like everything else. */
function topOfStack(err: unknown): string | null {
  if (!(err instanceof Error) || !err.stack) return null
  return err.stack.split('\n').slice(1, 6).map((l) => l.trim()).join(' | ')
}

function kindOf(contents: WebContents | null | undefined): string {
  if (!contents || contents.isDestroyed()) return 'unknown'
  return contents.getType()
}

/** Process exits and unresponsive pages, app-wide. Registered before app ready; runs once. */
export function installAppCapture(): void {
  if (appInstalled) return
  appInstalled = true
  app.on('render-process-gone', (_event, contents, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'error'
    log[level]('crash', 'A renderer process ended', { reason: details.reason, exitCode: details.exitCode, kind: kindOf(contents), origin: contents.isDestroyed() ? '' : originOf(contents.getURL()) })
    logger.flushSync()
  })
  app.on('child-process-gone', (_event, details) => {
    const level = details.reason === 'clean-exit' ? 'info' : 'warn'
    log[level]('crash', `A ${details.type} process ended`, { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? details.serviceName ?? null })
    logger.flushSync()
  })
  app.on('web-contents-created', (_event, contents) => {
    contents.on('unresponsive', () => log.warn('crash', 'A page stopped responding', { kind: kindOf(contents), origin: originOf(contents.getURL()) }))
    contents.on('responsive', () => log.info('crash', 'A page is responding again', { kind: kindOf(contents) }))
  })
}

/** The chrome's console warnings and errors, tagged 'chrome'. Returns the unsubscribe. */
export function captureChromeConsole(chrome: WebContents): () => void {
  const onMessage = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (event.level !== 'warning' && event.level !== 'error') return
    const file = event.sourceId ? basename(event.sourceId.split(/[?#]/)[0] ?? '') : ''
    log[event.level === 'error' ? 'error' : 'warn']('chrome', event.message, { file, line: event.lineNumber })
  }
  chrome.on('console-message', onMessage)
  return () => {
    if (!chrome.isDestroyed()) chrome.off('console-message', onMessage)
  }
}

// ── Outcomes from other modules, as kinds only ──

/** What the capture reads from the agent host: each chat's events, through the agent control hook. */
export interface AgentErrorSource {
  onControl(listener: (signal: { kind: string; event?: { type: string; code?: string } }) => void): () => void
}

/** Agent turns that end in an error: the error kind (SS-03's code) only, never the message or the chat. */
export function captureAgentErrors(agent: AgentErrorSource): () => void {
  return agent.onControl((signal) => {
    if (signal.kind !== 'event' || signal.event?.type !== 'error') return
    log.warn('agent', 'A turn ended with an error', { kind: signal.event.code ?? 'unknown' })
  })
}

export interface RoutineOutcomeItem {
  id: string
  lastRunAt: number | null
  lastStatus: 'ok' | 'error' | null
}

/**
 * The runs that ended since the last look, from the routine list: a routine
 * whose lastRunAt moved on. `seen` is updated in place; the first look only
 * records, so start-up never reports old runs.
 */
export function endedRuns(seen: Map<string, number | null>, items: readonly RoutineOutcomeItem[], first: boolean): Array<{ status: 'ok' | 'error' | 'other' }> {
  const ended: Array<{ status: 'ok' | 'error' | 'other' }> = []
  const ids = new Set<string>()
  for (const item of items) {
    ids.add(item.id)
    const before = seen.get(item.id)
    if (!first && item.lastRunAt !== null && (before === undefined || before === null || item.lastRunAt > before)) ended.push({ status: item.lastStatus ?? 'other' })
    seen.set(item.id, item.lastRunAt)
  }
  for (const id of [...seen.keys()]) if (!ids.has(id)) seen.delete(id)
  return ended
}

/** What the capture reads from the routine store. */
export interface RoutineOutcomeSource {
  list(): readonly RoutineOutcomeItem[]
  on(event: 'changed', listener: (items: RoutineOutcomeItem[]) => void): unknown
  off(event: 'changed', listener: (items: RoutineOutcomeItem[]) => void): unknown
}

/** Routine runs as they end: the outcome only, never the routine's name, prompt or chat. */
export function captureRoutineOutcomes(store: RoutineOutcomeSource): () => void {
  const seen = new Map<string, number | null>()
  endedRuns(seen, store.list(), true)
  const onChanged = (items: RoutineOutcomeItem[]): void => {
    for (const run of endedRuns(seen, items, false)) {
      if (run.status === 'error') log.warn('routines', 'A routine run failed', { status: run.status })
      else log.info('routines', 'A routine run ended', { status: run.status })
    }
  }
  store.on('changed', onChanged)
  return () => void store.off('changed', onChanged)
}

/** The speech helper exited: its code and whether Apex asked it to. For the speech HelperLink's 'exit'. */
export function captureSpeechExit(code: number | null, expected: boolean): void {
  if (expected && (code === 0 || code === null)) log.info('speech', 'The speech helper quit', { code })
  else log.warn('speech', 'The speech helper stopped unexpectedly', { code, expected })
}
