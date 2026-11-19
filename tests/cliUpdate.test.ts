/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { IDLE_UPDATE, updateBusy, type CliUpdateStatus } from '../src/engines/claude-code/shared/status'
import { lastLine, manualCommand, NPM_UPDATE, unsupportedUpdate, updateStep, type UpdateEvent } from '../src/engines/claude-code/main/cliUpdate'
import { updateLine, updateStatusLine } from '../src/engines/claude-code/renderer/logic'

// Update Claude Code as a state machine: background `claude update`, a fresh
// version check, and Terminal with the right command when it can't update itself.

const run = (events: UpdateEvent[], from: CliUpdateStatus = IDLE_UPDATE): CliUpdateStatus[] => {
  const states: CliUpdateStatus[] = []
  let state = from
  for (const event of events) {
    state = updateStep(state, event)
    states.push(state)
  }
  return states
}
const start: UpdateEvent = { type: 'start', from: '2.1.50', required: '2.1.280', at: 1000 }

describe('the update flow', () => {
  it('updates in the background, reads the version again, and is done once it is new enough', () => {
    const states = run([start, { type: 'output', text: 'Checking for updates...\n' }, { type: 'exited', code: 0, output: 'Successfully updated from 2.1.50 to version 2.1.316\n', timedOut: false }, { type: 'version', version: '2.1.316' }])
    expect(states.map((s) => s.phase)).toEqual(['updating', 'updating', 'checking', 'updated'])
    expect(states[1]?.detail).toBe('Checking for updates...')
    expect(states.at(-1)).toMatchObject({ from: '2.1.50', to: '2.1.316', required: '2.1.280', at: 1000 })
  })

  it('falls back to Terminal when `claude update` fails or says to use npm', () => {
    const npm = run([start, { type: 'exited', code: 1, output: 'Claude Code was installed with npm. To update, run: npm i -g @anthropic-ai/claude-code', timedOut: false }, { type: 'terminal', command: NPM_UPDATE }])
    expect(npm.map((s) => s.phase)).toEqual(['updating', 'opening-terminal', 'manual'])
    expect(npm.at(-1)?.command).toBe(NPM_UPDATE)
    // Exit 0, but its words say it didn't update this install.
    expect(run([start, { type: 'exited', code: 0, output: 'This install is managed by Homebrew. Run brew upgrade claude-code.', timedOut: false }])[1]?.phase).toBe('opening-terminal')
    expect(run([start, { type: 'exited', code: null, output: '', timedOut: true }])[1]).toMatchObject({ phase: 'opening-terminal', detail: 'timed out' })
  })

  it('an update that changed nothing goes to Terminal; one that changed it but not enough is still-old', () => {
    const exited: UpdateEvent = { type: 'exited', code: 0, output: 'Claude Code is up to date (2.1.50)', timedOut: false }
    expect(run([start, exited, { type: 'version', version: '2.1.50' }]).at(-1)?.phase).toBe('opening-terminal')
    expect(run([start, exited, { type: 'version', version: null }]).at(-1)?.phase).toBe('opening-terminal')
    expect(run([start, exited, { type: 'version', version: '2.1.270' }]).at(-1)).toMatchObject({ phase: 'still-old', to: '2.1.270' })
  })

  it('without a known minimum, any version read after the update counts as updated', () => {
    const states = run([{ ...start, required: null }, { type: 'exited', code: 0, output: '', timedOut: false }, { type: 'version', version: '2.1.50' }])
    expect(states.at(-1)?.phase).toBe('updated')
  })

  it('a Terminal that won’t open fails with the command to run yourself', () => {
    const states = run([start, { type: 'exited', code: 2, output: 'EACCES', timedOut: false }, { type: 'terminal-failed', command: 'claude update', detail: 'no Terminal' }])
    expect(states.at(-1)).toMatchObject({ phase: 'failed', command: 'claude update', detail: 'no Terminal' })
  })

  it('ignores events that don’t fit the phase, and a second start while one runs', () => {
    const updating = updateStep(IDLE_UPDATE, start)
    expect(updateStep(updating, { ...start, from: 'other' })).toBe(updating)
    expect(updateStep(IDLE_UPDATE, { type: 'version', version: '9.9.9' })).toBe(IDLE_UPDATE)
    expect(updateStep(IDLE_UPDATE, { type: 'terminal', command: 'x' })).toBe(IDLE_UPDATE)
    expect(updateStep(updating, { type: 'output', text: '\n\n' })).toBe(updating)
    // A finished update can start again.
    const done = run([start, { type: 'exited', code: 0, output: '', timedOut: false }, { type: 'version', version: '2.1.316' }]).at(-1) ?? IDLE_UPDATE
    expect(updateStep(done, { ...start, at: 2000 })).toMatchObject({ phase: 'updating', to: null, at: 2000 })
    expect(['updating', 'checking', 'opening-terminal'].every((p) => updateBusy(p as CliUpdateStatus['phase']))).toBe(true)
    expect(updateBusy('manual')).toBe(false)
  })
})

describe('the command for Terminal', () => {
  it('npm’s for an npm install or when claude update said so, Homebrew’s for a cask, else its own', () => {
    expect(manualCommand({ path: '/Users/x/.npm-global/bin/claude', source: 'login-shell' })).toBe(NPM_UPDATE)
    expect(manualCommand({ path: '/usr/local/bin/claude', source: 'common-path', realPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe' })).toBe(NPM_UPDATE)
    expect(manualCommand({ path: '/x/claude', source: 'common-path' }, 'To update, run: npm install -g @anthropic-ai/claude-code')).toBe(NPM_UPDATE)
    expect(manualCommand({ path: '/opt/homebrew/bin/claude', source: 'common-path', realPath: '/opt/homebrew/Caskroom/claude-code/2.1.50/claude' })).toBe('brew upgrade --cask claude-code')
    expect(manualCommand({ path: '/App/Resources/claude-code/claude', source: 'bundled' })).toBe(NPM_UPDATE)
    expect(manualCommand({ path: '/Users/x/.local/bin/claude', source: 'common-path' })).toBe('/Users/x/.local/bin/claude update')
    expect(manualCommand({ path: '/Users/x/My Tools/claude', source: 'override' }, '', 'darwin')).toBe("'/Users/x/My Tools/claude' update")
    // Windows: every claude.cmd is npm's shim; the native claude.exe updates itself, quoted for Command Prompt.
    expect(manualCommand({ path: 'C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd', source: 'login-shell' }, '', 'win32')).toBe(NPM_UPDATE)
    expect(manualCommand({ path: 'C:\\Program Files\\nodejs\\claude.cmd', source: 'common-path' }, '', 'win32')).toBe(NPM_UPDATE)
    expect(manualCommand({ path: 'C:\\Users\\Jo Smith\\.local\\bin\\claude.exe', source: 'common-path' }, '', 'win32')).toBe('"C:\\Users\\Jo Smith\\.local\\bin\\claude.exe" update')
  })

  it('reads output: unsupported wording, and the last line without colour codes', () => {
    expect(unsupportedUpdate('Please use npm to update')).toBe(true)
    expect(unsupportedUpdate('Successfully updated from 2.1.50 to version 2.1.316')).toBe(false)
    expect(lastLine('one\n\u001b[32mtwo\u001b[0m\n\n')).toBe('two')
    expect(lastLine('')).toBeNull()
  })
})

describe('progress words', () => {
  it('the card and Settings say where the update is', () => {
    const at = (phase: CliUpdateStatus['phase'], patch: Partial<CliUpdateStatus> = {}): CliUpdateStatus => ({ ...IDLE_UPDATE, phase, from: '2.1.50', required: '2.1.280', ...patch })
    expect(updateLine(at('idle'))).toBeNull()
    expect(updateLine(at('updating'))).toMatchObject({ key: 'engines.chat.error.update.updating', tone: 'busy' })
    expect(updateLine(at('updated', { to: '2.1.316' }))).toMatchObject({ key: 'engines.chat.error.update.updated', vars: { version: '2.1.316' } })
    expect(updateLine(at('manual', { command: NPM_UPDATE }))).toMatchObject({ key: 'engines.chat.error.update.manual', vars: { command: NPM_UPDATE } })
    expect(updateStatusLine(at('checking'))).toMatchObject({ busy: true, text: 'Checking the new version…' })
    expect(updateStatusLine(at('still-old', { to: '2.1.270' }))?.text).toBe('Now 2.1.270, still older than 2.1.280.')
    expect(updateStatusLine(at('failed', { detail: 'no Terminal' }))?.tone).toBe('warning')
  })
})

describe('a broken update', () => {
  it('ends as failed from any running phase, so the next one can start', () => {
    for (const phase of ['updating', 'checking', 'opening-terminal'] as const) {
      expect(updateStep({ ...IDLE_UPDATE, phase }, { type: 'error', detail: 'boom' })).toMatchObject({ phase: 'failed', detail: 'boom' })
    }
    expect(updateStep(IDLE_UPDATE, { type: 'error', detail: 'boom' })).toBe(IDLE_UPDATE)
  })
})
