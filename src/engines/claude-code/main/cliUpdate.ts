/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compareVersions, IDLE_UPDATE, updateBusy, type CliSource, type CliUpdateStatus } from '../shared/status'
import { shellQuote } from '../../../../src/main/system/shell'

// Update Claude Code as a small state machine, so the card, Settings and the
// tests read one set of rules:
//
//   idle ─start→ updating ─exited ok→ checking ─version new enough→ updated
//                    │                    ├─version still below→ still-old
//                    │                    └─version unchanged→ opening-terminal
//                    └─failed or unsupported→ opening-terminal ─opened→ manual
//                                                              └─couldn't→ failed
//
// `claude update` runs in the background; an install it can't update itself
// (npm and Homebrew ones may say to use their package manager) gets Terminal
// with the right command instead. Nothing here sends a message to a model.

export type UpdateEvent =
  | { type: 'start'; from: string | null; required: string | null; at: number }
  | { type: 'output'; text: string }
  | { type: 'exited'; code: number | null; output: string; timedOut: boolean }
  | { type: 'version'; version: string | null }
  | { type: 'terminal'; command: string }
  | { type: 'terminal-failed'; command: string; detail: string }
  /** Something broke on the way: a running update ends as failed, so the next one can start. */
  | { type: 'error'; detail: string }

/** Output of `claude update` that means it won't update this install itself. */
const UNSUPPORTED = /npm (?:i|install)\b|use npm|homebrew|brew upgrade|package manager|not supported|isn[’']t supported|cannot update|can[’']t update|unable to update|eacces|permission denied|unknown command|did you mean|auto-?updates? (?:are|is) disabled/i

/** Whether `claude update`'s output says to update some other way. */
export function unsupportedUpdate(output: string): boolean {
  return UNSUPPORTED.test(output)
}

/** The last line worth showing from some output, clipped. */
export function lastLine(output: string): string | null {
  const line = output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).at(-1)
  if (!line) return null
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** One step of the machine. Events that don't fit the phase change nothing. */
export function updateStep(state: CliUpdateStatus, event: UpdateEvent): CliUpdateStatus {
  switch (event.type) {
    case 'start':
      if (updateBusy(state.phase)) return state
      return { ...IDLE_UPDATE, phase: 'updating', from: event.from, required: event.required, at: event.at }
    case 'output': {
      if (state.phase !== 'updating') return state
      const line = lastLine(event.text)
      return line ? { ...state, detail: line } : state
    }
    case 'exited': {
      if (state.phase !== 'updating') return state
      const detail = lastLine(event.output) ?? state.detail
      if (event.code === 0 && !event.timedOut && !unsupportedUpdate(event.output)) return { ...state, phase: 'checking', detail }
      return { ...state, phase: 'opening-terminal', detail: event.timedOut ? 'timed out' : detail }
    }
    case 'version': {
      if (state.phase !== 'checking') return state
      const v = event.version
      const enough = v !== null && (!state.required || compareVersions(v, state.required) >= 0)
      if (enough) return { ...state, phase: 'updated', to: v }
      // It said it updated, yet nothing changed: let the person run it where they can see it.
      if (v === null || v === state.from) return { ...state, phase: 'opening-terminal', to: v }
      return { ...state, phase: 'still-old', to: v }
    }
    case 'terminal':
      if (state.phase !== 'opening-terminal') return state
      return { ...state, phase: 'manual', command: event.command }
    case 'terminal-failed':
      if (state.phase !== 'opening-terminal') return state
      return { ...state, phase: 'failed', command: event.command, detail: event.detail }
    case 'error':
      if (!updateBusy(state.phase)) return state
      return { ...state, phase: 'failed', detail: event.detail }
  }
}

/**
 * The command that updates an install by hand: npm's for an npm install
 * (or when `claude update` said to use npm) * (and for the copy inside Atelier, which only an Atelier update replaces, so a
 * separate install takes over), Homebrew's for a cask, else its own update.
 */
export function manualCommand(install: { path: string; source: CliSource; realPath?: string | null }, output = '', platform: NodeJS.Platform = process.platform): string {
  const where = `${install.path}\n${install.realPath ?? ''}`
  // On Windows every .cmd claude is npm's shim (the native install is claude.exe).
  if (install.source === 'bundled' || /node_modules[\\/]@anthropic-ai[\\/]claude-code|\.npm-global|[\\/]npm[\\/]|\.cmd$/im.test(where) || /\bnpm (?:i|install)\b/i.test(output)) return NPM_UPDATE
  if (/\/Caskroom\/claude-code/i.test(where) || /\bbrew upgrade\b/i.test(output)) return 'brew upgrade --cask claude-code'
  return `${shellQuote(install.path, platform)} update`
}

export const NPM_UPDATE = 'npm i -g @anthropic-ai/claude-code@latest'
