/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// ST-09: draws the chosen companion's Dock image and hands it to main. Used
// by Settings › Dock icon right after a choice, and (once wired) by the main
// window so the choice survives a relaunch: main keeps no image of its own.
import { useEffect } from 'react'
import { lookKey } from '@shared/companionLogic'
import type { Companion } from '@shared/companion'
import type { Settings } from '@shared/ipc'
import { atelier, call, errorText } from '../api'
import { companionImage } from '../components/companionData'
import { renderDockIcon } from '../companion/dockRender'
import { chosenCompanion } from './logic/dock'

export { chosenCompanion }

/** The Dock image size; macOS scales it down for the Dock and the app switcher. */
export const DOCK_IMAGE_SIZE = 512
const DELAY_MS = 600

/** Renders `companion`'s Dock image and sends it to main; false when main dropped it (the choice moved on). */
export async function applyDockChoice(companion: Pick<Companion, 'id' | 'look'>): Promise<boolean> {
  // The designed icon (ST-09's designer) wins over the plain head, so a relaunch keeps it.
  const design = await call('dockIcon', 'design').catch(() => null)
  const url = design ? await renderDockIcon(design, companion.look, DOCK_IMAGE_SIZE) : await companionImage(companion.look, DOCK_IMAGE_SIZE)
  return call('dockChoice', 'apply', companion.id, url)
}

/** Keeps the Dock in step with the choice and the chosen companion's look (macOS only). */
export function useDockChoice(choice: Settings['dockIcon'], companions: readonly Companion[] | null): void {
  const chosen = chosenCompanion(choice, companions)
  const key = chosen ? `${chosen.id}:${lookKey(chosen.look)}` : null
  useEffect(() => {
    if (!chosen || atelier.platform !== 'darwin') return
    let live = true
    const timer = setTimeout(() => {
      if (!live) return
      applyDockChoice(chosen).catch((err: unknown) => console.warn('The Dock icon could not be updated:', errorText(err)))
    }, DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])
}
