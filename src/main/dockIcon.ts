/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Settings } from '@shared/ipc'
import { DEFAULT_DOCK_DESIGN, clampDockDesign, type DockIconDesign, type DockIconService } from '@shared/onboarding'
import { dockIconImage, resetDockIcon, setDockIcon } from './companion'
import { log } from './log'
import { writeAtomic } from './settings'

// The Dock icon choice (ST-09): Atelier's standard icon or one companion,
// saved as settings.dockIcon. Older versions kept a per-companion `dockIcon` flag; the
// flag now mirrors the choice (true on the chosen companion only), so the
// card's "Show in the Dock" switch and Settings › Dock icon stay in step.
// A deleted companion falls back to the standard icon.

export { dockIconImage, resetDockIcon, setDockIcon }

export type DockChoice = Settings['dockIcon']

interface FlaggedCompanion {
  id: string
  dockIcon: boolean
}

/** The choice that holds given the companions that exist: a missing companion means standard. */
export function resolveDockChoice(choice: DockChoice, companions: readonly { id: string }[]): DockChoice {
  if (choice.kind === 'companion' && !companions.some((c) => c.id === choice.companionId)) return { kind: 'standard' }
  return choice
}

/**
 * The first run after that change: settings say standard, but a companion still has
 * its old flag on. That companion (the active one first) becomes the choice.
 */
export function migratedDockChoice(choice: DockChoice, companions: readonly FlaggedCompanion[], activeId: string): DockChoice | null {
  if (choice.kind !== 'standard') return null
  const flagged = companions.filter((c) => c.dockIcon)
  if (flagged.length === 0) return null
  const pick = flagged.find((c) => c.id === activeId) ?? flagged[0]
  return pick ? { kind: 'companion', companionId: pick.id } : null
}

/** The flag changes that make the companions mirror the choice. */
export function flagPatches(choice: DockChoice, companions: readonly FlaggedCompanion[]): Array<{ id: string; dockIcon: boolean }> {
  const chosen = choice.kind === 'companion' ? choice.companionId : null
  return companions.filter((c) => c.dockIcon !== (c.id === chosen)).map((c) => ({ id: c.id, dockIcon: c.id === chosen }))
}

/**
 * A flag someone flipped on a companion (the card's switch): turning it on
 * picks that companion; turning off the chosen one goes back to standard.
 * Returns null when the flags already agree with the choice.
 */
export function choiceFromFlags(choice: DockChoice, before: readonly FlaggedCompanion[], after: readonly FlaggedCompanion[]): DockChoice | null {
  const was = new Map(before.map((c) => [c.id, c.dockIcon]))
  const turnedOn = after.find((c) => c.dockIcon && was.get(c.id) === false)
  if (turnedOn && !(choice.kind === 'companion' && choice.companionId === turnedOn.id)) return { kind: 'companion', companionId: turnedOn.id }
  if (choice.kind === 'companion') {
    const chosen = after.find((c) => c.id === choice.companionId)
    if (chosen && !chosen.dockIcon && was.get(chosen.id) === true) return { kind: 'standard' }
  }
  return null
}

// ST-10
// The design is kept in userData/dock-icon.json, clamped on load and save.
// The chrome draws the icon (dockRender.ts) and hands the PNG to apply(),
// which sets it with app.dock.setIcon on macOS and does nothing elsewhere.

export const DOCK_DESIGN_FILE = 'dock-icon.json'

export interface DockDesignDeps {
  dataDir: string
  /** Sets the Dock image; false when there is no Dock (not macOS). */
  setIcon?(pngDataUrl: string): boolean
}

export function createDockIconService(deps: DockDesignDeps): DockIconService {
  const path = join(deps.dataDir, DOCK_DESIGN_FILE)
  let design: DockIconDesign = { ...DEFAULT_DOCK_DESIGN }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; design?: unknown }
    if (raw && raw.version === 1) design = clampDockDesign(raw.design)
  } catch {
    // No design saved yet.
  }
  const write = (): void => {
    try {
      writeAtomic(path, `${JSON.stringify({ version: 1, design }, null, 2)}\n`)
    } catch (err) {
      log.warn('dock', 'Could not save the Dock icon design', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  const setIcon = deps.setIcon ?? ((png: string) => setDockIcon(dockIconImage(png)))
  return {
    design: () => clampDockDesign(design),
    save(next) {
      design = clampDockDesign(next)
      write()
      return clampDockDesign(design)
    },
    reset() {
      design = { ...DEFAULT_DOCK_DESIGN, companionId: design.companionId }
      write()
      return clampDockDesign(design)
    },
    apply(pngDataUrl) {
      try {
        return setIcon(pngDataUrl)
      } catch (err) {
        log.warn('dock', 'The Dock icon could not be set', { error: err instanceof Error ? err.message : String(err) })
        return false
      }
    },
  }
}
