/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CommandId } from '@shared/shortcuts'
import type { WindowContext } from './features/types'
import { log } from './log'

// The command registry. Shortcuts, menus, the command bar
// and the main menu run commands by id; each feature registers its own. An
// intercept lets another feature take over a command in a context (⌘F in a
// chat): among matching intercepts the last registered one runs.

/** A run may return false to report that it couldn't do anything (NS-04 beeps). */
export type CommandRun = (win: WindowContext | null) => void | boolean | Promise<void | boolean>

export interface CommandOptions {
  enabled?(win: WindowContext | null): boolean
  checked?(win: WindowContext | null): boolean
}

export interface CommandIntercept {
  when(win: WindowContext | null): boolean
  run(win: WindowContext | null): void | Promise<void>
}

export interface CommandState {
  enabled: boolean
  checked?: boolean
}

// The guides feature installs shell.beep()
let failureCue: () => void = () => undefined

/** Sets what plays when a command fails; returns a function that removes it. */
export function setCommandFailureCue(cue: () => void): () => void {
  failureCue = cue
  return () => {
    if (failureCue === cue) failureCue = () => undefined
  }
}

export class CommandRegistry {
  readonly #commands = new Map<CommandId, { run: CommandRun; opts: CommandOptions }>()
  readonly #intercepts = new Map<CommandId, CommandIntercept[]>()

  register(id: CommandId, run: CommandRun, opts: CommandOptions = {}): () => void {
    if (this.#commands.has(id)) throw new Error(`Command ${id} is already registered.`)
    const entry = { run, opts }
    this.#commands.set(id, entry)
    return () => {
      if (this.#commands.get(id) === entry) this.#commands.delete(id)
    }
  }

  intercept(id: CommandId, h: CommandIntercept): () => void {
    const list = this.#intercepts.get(id) ?? []
    list.push(h)
    this.#intercepts.set(id, list)
    return () => {
      const i = list.indexOf(h)
      if (i >= 0) list.splice(i, 1)
    }
  }

  has(id: CommandId): boolean {
    return this.#commands.has(id)
  }

  /** Runs the last matching intercept, else the command. Unregistered or disabled commands do nothing. */
  async run(id: CommandId, win: WindowContext | null): Promise<boolean> {
    const intercepts = this.#intercepts.get(id) ?? []
    for (let i = intercepts.length - 1; i >= 0; i--) {
      const h = intercepts[i]
      if (h?.when(win)) {
        await h.run(win)
        return true
      }
    }
    const entry = this.#commands.get(id)
    if (!entry || entry.opts.enabled?.(win) === false) return false
    try {
      // A command that throws or reports failure plays the failure cue (the system beep)
      if ((await entry.run(win)) === false) failureCue()
    } catch (err) {
      log.error('commands', `Command ${id} failed`, { error: err instanceof Error ? err.message : String(err) })
      failureCue()
    }
    return true
  }

  /** Every registered command's state for a window; menus render unregistered ones disabled. */
  available(win: WindowContext | null): Partial<Record<CommandId, CommandState>> {
    const out: Partial<Record<CommandId, CommandState>> = {}
    for (const [id, { opts }] of this.#commands) {
      const checked = opts.checked?.(win)
      out[id] = { enabled: opts.enabled?.(win) ?? true, ...(checked === undefined ? {} : { checked }) }
    }
    return out
  }
}

/** The app's one registry. */
export const commands = new CommandRegistry()
