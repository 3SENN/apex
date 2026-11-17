/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Input } from 'electron'
import { normalizeAccelerator } from '../shortcuts'
import type { Manifest } from './manifest'

// Manifest commands. Chrome's suggested keys become Electron
// accelerators; each registers through shortcuts.registerRuntime unless a
// built-in shortcut already holds the key, and then the clash shows on the
// extension's row. `_execute_action` clicks the toolbar button.

export const EXECUTE_ACTION = '_execute_action'
const LEGACY_ACTIONS = new Set(['_execute_browser_action', '_execute_page_action'])
/** Chrome allows letters, digits, F-keys and a few named keys. */
const KEY = /^([A-Z0-9]|F([1-9]|1[0-2])|Comma|Period|Home|End|PageUp|PageDown|Space|Insert|Delete|Up|Down|Left|Right|MediaNextTrack|MediaPlayPause|MediaPrevTrack|MediaStop)$/

export interface ExtensionCommand {
  /** The manifest name; legacy action names read as `_execute_action`. */
  name: string
  description: string
  /** An Electron accelerator, or null when the manifest suggests none (or an invalid one). */
  accelerator: string | null
}

const NAMED: Record<string, string> = { Comma: ',', Period: '.', Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right', Space: 'Space' }

/**
 * Converts Chrome's shortcut syntax to an Electron accelerator. On a Mac,
 * Chrome reads "Ctrl" as Command and "MacCtrl" as Control; "Command" is
 * Command everywhere it is allowed. Needs a modifier other than Shift
 * alone, as Chrome does. Returns null when it isn't valid.
 */
export function toAccelerator(chromeKey: string, platform: string = process.platform): string | null {
  const parts = chromeKey.split('+').map((p) => p.trim())
  const key = parts.pop()
  if (!key || !KEY.test(key)) return null
  const mac = platform === 'darwin'
  const mods = new Set<string>()
  for (const p of parts) {
    if (p === 'Ctrl') mods.add(mac ? 'Command' : 'Ctrl')
    else if (p === 'Command') mods.add('Command')
    else if (p === 'MacCtrl') {
      if (!mac) return null
      mods.add('Ctrl')
    } else if (p === 'Alt') mods.add('Alt')
    else if (p === 'Shift') mods.add('Shift')
    else if (p === 'Search') return null
    else return null
  }
  if (mods.size === 0 || (mods.size === 1 && mods.has('Shift'))) return null
  const order = ['Command', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m))
  return [...order, NAMED[key] ?? key].join('+')
}

/** The manifest's commands, with each one's suggested key for this platform. */
export function manifestCommands(m: Manifest, platform: string = process.platform): ExtensionCommand[] {
  const out: ExtensionCommand[] = []
  for (const [rawName, cmd] of Object.entries(m.commands ?? {})) {
    if (!cmd || typeof cmd !== 'object') continue
    const name = LEGACY_ACTIONS.has(rawName) ? EXECUTE_ACTION : rawName
    const suggested = cmd.suggested_key
    const key = suggested ? (platform === 'darwin' ? (suggested.mac ?? suggested.default) : platform === 'linux' ? (suggested.linux ?? suggested.default) : (suggested.windows ?? suggested.default)) : undefined
    out.push({ name, description: typeof cmd.description === 'string' ? cmd.description : '', accelerator: typeof key === 'string' ? toAccelerator(key, platform) : null })
  }
  // Chrome registers at most four suggested keys per extension.
  let withKeys = 0
  return out.map((c) => (c.accelerator && ++withKeys > 4 ? { ...c, accelerator: null } : c))
}

const INPUT_KEYS: Record<string, string> = { ' ': 'Space', ',': ',', '.': '.', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }

/** The accelerator a keyDown spells, normalized the way shortcuts.ts compares them; null for other events. */
export function inputAccelerator(input: Pick<Input, 'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift'>, platform: string = process.platform): string | null {
  if (input.type !== 'keyDown') return null
  let key = INPUT_KEYS[input.key] ?? input.key
  // With Alt or Shift held, `key` is the shifted character; the physical key is what Chrome binds.
  const code = /^Key([A-Z])$/.exec(input.code)?.[1] ?? /^Digit([0-9])$/.exec(input.code)?.[1]
  if (code) key = code
  if (key.length === 1) key = key.toUpperCase()
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null
  const mods = [input.meta ? 'Command' : '', input.control ? 'Ctrl' : '', input.alt ? 'Alt' : '', input.shift ? 'Shift' : ''].filter(Boolean)
  if (mods.length === 0) return null
  return normalizeAccelerator([...mods, key].join('+'), platform)
}
